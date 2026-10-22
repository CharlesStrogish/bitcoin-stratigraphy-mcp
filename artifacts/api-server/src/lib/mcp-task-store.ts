import { pool } from "@workspace/db";

export type TaskRecord = {
  taskId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: "working" | "input_required" | "completed" | "cancelled" | "failed";
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  revision: number;
  inputKey?: string;
  inputRequests?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  traceparent?: string;
};

export interface McpTaskStore {
  create(task: TaskRecord): Promise<void>;
  get(id: string): Promise<TaskRecord | undefined>;
  replace(task: TaskRecord, revision: number): Promise<boolean>;
}

/** Test double only. Production task handles are persisted before responding. */
export function memoryMcpTaskStore(): McpTaskStore {
  const rows = new Map<string, TaskRecord>();
  return {
    async create(task) { rows.set(task.taskId, structuredClone(task)); },
    async get(id) { const row = rows.get(id); return row && structuredClone(row); },
    async replace(task, revision) {
      if (rows.get(task.taskId)?.revision !== revision) return false;
      rows.set(task.taskId, structuredClone(task));
      return true;
    },
  };
}

export function postgresMcpTaskStore(): McpTaskStore {
  let ready: Promise<unknown> | undefined;
  const ensure = async () => {
    if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS mcp_extension_tasks (
      task_id text PRIMARY KEY, revision integer NOT NULL, state jsonb NOT NULL,
      expires_at timestamptz NOT NULL
    )`).catch((error: unknown) => { ready = undefined; throw error; });
    await ready;
  };
  return {
    async create(task) {
      await ensure();
      // Serializes admission across replicas without storing any payment secrets.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(726633)");
        await client.query("DELETE FROM mcp_extension_tasks WHERE expires_at < now()");
        const count = await client.query("SELECT count(*)::int AS n FROM mcp_extension_tasks");
        if (Number(count.rows[0]?.n) >= 1000) throw new Error("Task capacity exhausted");
        await client.query(
          "INSERT INTO mcp_extension_tasks(task_id, revision, state, expires_at) VALUES ($1,$2,$3,$4)",
          [task.taskId, task.revision, JSON.stringify(task),
            new Date(Date.parse(task.createdAt) + task.ttlMs)],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async get(id) {
      await ensure();
      const row = await pool.query(
        "SELECT state FROM mcp_extension_tasks WHERE task_id=$1 AND expires_at > now()", [id],
      );
      return row.rows[0]?.state as TaskRecord | undefined;
    },
    async replace(task, revision) {
      await ensure();
      const updated = await pool.query(
        "UPDATE mcp_extension_tasks SET state=$1, revision=$2 WHERE task_id=$3 AND revision=$4 AND expires_at > now()",
        [JSON.stringify(task), task.revision, task.taskId, revision],
      );
      return updated.rowCount === 1;
    },
  };
}
