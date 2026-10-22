import { randomBytes } from "node:crypto";
import type { McpTaskOutcome } from "./mcp-async-tasks";
import { type McpTaskStore, type TaskRecord, postgresMcpTaskStore } from "./mcp-task-store";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const TASK_TOOLS = new Set(["stratigraphy.get_range", "proof.submit"]);
const MAX_EXECUTION_MS = 180_000;
const token = () => randomBytes(32).toString("base64url");

export function supportsTasks(capabilities: unknown): boolean {
  const extensions = (capabilities as { extensions?: Record<string, unknown> } | undefined)?.extensions;
  const value = extensions?.[TASKS_EXTENSION];
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Task IDs are unguessable bearer capabilities; never enumerate or log them. */
export class McpTasksExtension {
  private active = new Map<string, AbortController>();
  constructor(readonly store: McpTaskStore = postgresMcpTaskStore()) {}

  publicView(task: TaskRecord, resultType = "complete"): Record<string, unknown> {
    const { tool: _tool, arguments: _args, revision: _revision, inputKey: _inputKey,
      traceparent: _traceparent, ...view } = task;
    return { resultType, ...view };
  }

  async create(tool: string, args: Record<string, unknown>, invalid?: string, traceparent?: string) {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      taskId: token(), tool, arguments: args, status: "working",
      createdAt: now, lastUpdatedAt: now, ttlMs: 3_600_000,
      pollIntervalMs: 1000, revision: 0, ...(traceparent ? { traceparent } : {}),
    };
    if (invalid) this.requireInput(task, invalid);
    await this.store.create(task);
    return task;
  }

  requireInput(task: TaskRecord, message: string) {
    const key = token();
    task.status = "input_required";
    task.inputKey = key;
    task.inputRequests = {
      [key]: {
        method: "elicitation/create",
        params: { mode: "form", message,
          requestedSchema: { type: "object", properties: {
            arguments: { type: "string", description: "Corrected tool arguments as a JSON object string" },
          }, required: ["arguments"] } },
      },
    };
  }

  async get(id: unknown) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    let task = await this.store.get(id);
    if (!task || Date.now() >= Date.parse(task.createdAt) + task.ttlMs) return undefined;
    // Never replay charged work after a worker crash or process restart.
    if (task.status === "working" &&
        Date.now() - Date.parse(task.lastUpdatedAt) > MAX_EXECUTION_MS + 30_000) {
      const revision = task.revision;
      task = { ...task, revision: revision + 1, status: "failed",
        error: { code: -32603, message: "Task execution interrupted; not automatically replayed" } };
      await this.store.replace(task, revision);
      task = await this.store.get(id);
    }
    return task;
  }

  async cancel(task: TaskRecord) {
    if (["working", "input_required"].includes(task.status)) {
      const updated: TaskRecord = { ...task, status: "cancelled",
        lastUpdatedAt: new Date().toISOString(), revision: task.revision + 1 };
      delete updated.inputRequests;
      delete updated.inputKey;
      await this.store.replace(updated, task.revision);
      this.active.get(task.taskId)?.abort();
    }
  }

  /** CAS prevents duplicate updates, repeated execution, or resurrection after cancel. */
  async start(task: TaskRecord, args: Record<string, unknown>,
    execute: (signal: AbortSignal) => Promise<McpTaskOutcome>) {
    const running: TaskRecord = { ...task, arguments: args, status: "working",
      lastUpdatedAt: new Date().toISOString(), revision: task.revision + 1 };
    delete running.inputKey;
    delete running.inputRequests;
    if (!await this.store.replace(running, task.revision)) return false;
    const controller = new AbortController();
    this.active.set(task.taskId, controller);
    const timer = setTimeout(() => controller.abort(), MAX_EXECUTION_MS);
    timer.unref();
    // Persist terminal state before it can be observed by a poll.
    void (async () => {
      try {
        const outcome = await Promise.race([
          execute(controller.signal),
          new Promise<McpTaskOutcome>((resolve) => controller.signal.addEventListener("abort",
            () => resolve({ error: { code: -32603, message: "Task execution cancelled or timed out" } }),
            { once: true })),
        ]);
        const current = await this.store.get(task.taskId);
        if (!current || current.status !== "working") return;
        const finished: TaskRecord = { ...current, revision: current.revision + 1,
          lastUpdatedAt: new Date().toISOString(),
          ...("result" in outcome ? { status: "completed", result: outcome.result }
            : { status: "failed", error: outcome.error }) };
        await this.store.replace(finished, current.revision);
      } catch {
        const current = await this.store.get(task.taskId).catch(() => undefined);
        if (current?.status === "working") await this.store.replace({
          ...current, revision: current.revision + 1, status: "failed",
          error: { code: -32603, message: "Task execution unavailable" },
        }, current.revision).catch(() => false);
      } finally {
        clearTimeout(timer);
        this.active.delete(task.taskId);
      }
    })();
    return true;
  }
}
