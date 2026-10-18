// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "./logger";
import { RELEASE_VERSION } from "./public-site";

/**
 * Zero-polling execution for long-running paid tools. A paid call that names
 * a webhook_url is acknowledged with HTTP 202 and a task_id; the tool then
 * runs in this process and its final JSON-RPC result (or error) is POSTed to
 * the callback. Tasks live in memory only: a restart loses queued work.
 * This is not the MCP Tasks extension (no tasks/get, no resultType "task").
 */

/** Canonical tool names that accept webhook_url. */
export const MCP_ASYNC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "proof.submit",
  "stratigraphy.get_range",
]);

export const WEBHOOK_URL_MAX_LENGTH = 2048;
export const WEBHOOK_URL_PATTERN = "^https://";
export const WEBHOOK_URL_DESCRIPTION =
  "Optional public HTTPS callback URL for zero-polling execution. On a paid call the server answers HTTP 202 Accepted with a JSON-RPC result containing task_id and status pending, runs the tool in the background, then POSTs one JSON body with task_id, status (completed or failed), tool, request_id and the final MCP result or JSON-RPC error. Omit it to receive the result synchronously. Loopback, private, link-local and other reserved addresses are rejected before any invoice is issued.";
export const WEBHOOK_URL_EXAMPLE = "https://agent.example.com/mcp/callbacks";

const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata services
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");
}

// Only global unicast IPv6 is reachable; mapped, NAT64-style embeddings and
// unique-local or link-local ranges all fall outside 2000::/3.
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], // IETF protocol assignments, including Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, which embeds an IPv4 address
  ["3fff::", 20], // documentation
] as const) {
  BLOCKED_IPV6.addSubnet(network, prefix, "ipv6");
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  try {
    switch (isIP(address)) {
      case 4:
        return !BLOCKED_IPV4.check(address, "ipv4");
      case 6:
        return (
          GLOBAL_UNICAST_IPV6.check(address, "ipv6") &&
          !BLOCKED_IPV6.check(address, "ipv6")
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

const bareHostname = (url: URL): string =>
  url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;

const NON_PUBLIC_SUFFIX =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/;

/** Static URL policy; DNS answers are checked separately before payment. */
export function webhookUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "webhook_url must be an absolute URL";
  }
  if (url.protocol !== "https:") return "webhook_url must use https";
  if (url.username || url.password) {
    return "webhook_url must not contain credentials";
  }
  const host = bareHostname(url).toLowerCase().replace(/\.$/, "");
  if (isIP(host)) {
    return isPublicAddress(host)
      ? undefined
      : "webhook_url must not target a loopback, private or reserved address";
  }
  if (!host.includes(".") || NON_PUBLIC_SUFFIX.test(host)) {
    return "webhook_url must name a public host";
  }
  return undefined;
}

export const webhookUrlSchema = z
  .string()
  .max(WEBHOOK_URL_MAX_LENGTH)
  .regex(new RegExp(WEBHOOK_URL_PATTERN))
  .superRefine((value, context) => {
    const problem = webhookUrlProblem(value);
    if (problem)
      context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  })
  .describe(WEBHOOK_URL_DESCRIPTION);

/** Arguments forwarded to the tool itself never include the callback. */
export function withoutWebhookUrl<T>(arguments_: T): T {
  if (
    arguments_ === null ||
    typeof arguments_ !== "object" ||
    Array.isArray(arguments_) ||
    !Object.hasOwn(arguments_, "webhook_url")
  ) {
    return arguments_;
  }
  const rest = { ...(arguments_ as Record<string, unknown>) };
  delete rest.webhook_url;
  return rest as T;
}

/** The validated callback of a webhook-capable call, if one was supplied. */
export function requestedWebhookUrl(
  canonicalName: string,
  arguments_: unknown,
): string | undefined {
  if (!MCP_ASYNC_TOOL_NAMES.has(canonicalName)) return undefined;
  if (arguments_ === null || typeof arguments_ !== "object") return undefined;
  const value = (arguments_ as { webhook_url?: unknown }).webhook_url;
  return typeof value === "string" ? value : undefined;
}

/** Raised when a callback host is not publicly routable or cannot resolve. */
export class WebhookTargetError extends Error {
  constructor(message = "webhook_url must resolve only to public addresses") {
    super(message);
    this.name = "WebhookTargetError";
  }
}

export type ResolveHost = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

const systemResolveHost: ResolveHost = (hostname) =>
  lookup(hostname, { all: true });

const RESOLVE_TIMEOUT_MS = 5_000;

async function resolvePublicAddresses(
  host: string,
  resolveHost: ResolveHost,
  isAllowedAddress: (address: string) => boolean,
): Promise<{ address: string; family: number }[]> {
  const family = isIP(host);
  if (family !== 0) {
    if (!isAllowedAddress(host)) throw new WebhookTargetError();
    return [{ address: host, family }];
  }
  let timer: NodeJS.Timeout | undefined;
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await Promise.race([
      resolveHost(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new WebhookTargetError("webhook_url host did not resolve")),
          RESOLVE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof WebhookTargetError) throw error;
    throw new WebhookTargetError("webhook_url host did not resolve");
  } finally {
    clearTimeout(timer);
  }
  // Every answer must be public: a mixed answer lets a resolver steer one
  // later connection to an internal service.
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isAllowedAddress(address))
  ) {
    throw new WebhookTargetError();
  }
  return addresses.map(({ address, family: addressFamily }) => ({
    address,
    family: addressFamily === 6 ? 6 : 4,
  }));
}

export type WebhookDelivery = {
  url: URL;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
};

/** Sends one POST and resolves with the HTTP status code. */
export type WebhookTransport = (delivery: WebhookDelivery) => Promise<number>;

/**
 * POSTs over HTTPS to a pinned, re-validated address. The socket connects to
 * the address that passed the policy check (no second DNS answer can swap in
 * a private target), TLS still verifies the certificate for the URL host, and
 * redirects are never followed.
 */
export function createHttpsWebhookTransport(
  options: {
    resolveHost?: ResolveHost;
    isAllowedAddress?: (address: string) => boolean;
    /** Tests substitute http.request for a local receiver. */
    request?: typeof https.request;
  } = {},
): WebhookTransport {
  const resolveHost = options.resolveHost ?? systemResolveHost;
  const isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;
  const request = options.request ?? https.request;
  return async ({ url, body, headers, signal }) => {
    const host = bareHostname(url);
    const [pinned] = await resolvePublicAddresses(
      host,
      resolveHost,
      isAllowedAddress,
    );
    const { address, family } = pinned!;
    const pinnedLookup: NonNullable<https.RequestOptions["lookup"]> = (
      _hostname,
      lookupOptions,
      callback,
    ) => {
      if (lookupOptions.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    return await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: host,
          ...(url.port === "" ? {} : { port: Number(url.port) }),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": String(Buffer.byteLength(body)),
          },
          agent: false,
          signal,
          lookup: pinnedLookup,
          ...(isIP(host) === 0 ? { servername: host } : {}),
        },
        (response) => {
          resolve(response.statusCode ?? 0);
          // Only the status matters; never buffer an untrusted response body.
          response.destroy();
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  };
}

export type McpTaskError = { code: number; message: string; data?: unknown };

export type McpTaskOutcome =
  { result: Record<string, unknown> } | { error: McpTaskError };

export type McpTaskAcknowledgement = {
  task_id: string;
  status: "pending";
  tool: string;
  created_at: string;
};

export type McpTaskWebhookPayload = {
  task_id: string;
  status: "completed" | "failed";
  tool: string;
  request_id: string | number | null;
  created_at: string;
  completed_at: string;
  result?: Record<string, unknown>;
  error?: McpTaskError;
};

type TaskLogger = Pick<typeof logger, "info" | "warn" | "error">;

export type McpAsyncTaskRunnerOptions = {
  transport?: WebhookTransport;
  resolveHost?: ResolveHost;
  isAllowedAddress?: (address: string) => boolean;
  maxConcurrent?: number;
  maxPending?: number;
  taskTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  deliveryAttempts?: number;
  retryDelayMs?: number;
  now?: () => number;
  logger?: TaskLogger;
};

export type McpAsyncTaskRunner = {
  /** False once accepted-but-undelivered tasks reach the pending cap. */
  hasCapacity(): boolean;
  /** Pre-payment DNS policy check; throws WebhookTargetError. */
  checkWebhookTarget(webhookUrl: string): Promise<void>;
  /** Queues a paid task; call only after payment has been verified. */
  accept(input: {
    tool: string;
    webhookUrl: string;
    requestId?: string | number | null;
    execute: (signal: AbortSignal) => Promise<McpTaskOutcome>;
  }): McpTaskAcknowledgement;
  /** Resolves when every accepted task has finished delivery. */
  drain(): Promise<void>;
};

type QueuedTask = {
  id: string;
  tool: string;
  webhook: URL;
  requestId: string | number | null;
  createdAt: number;
  execute: (signal: AbortSignal) => Promise<McpTaskOutcome>;
};

const RETRYABLE_STATUSES = new Set([408, 425, 429]);
const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUSES.has(status) || status >= 500;

const errorReason = (error: unknown): string => {
  if (error && typeof error === "object") {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === "string") return code;
    if (typeof name === "string") return name;
  }
  return "delivery error";
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export function createMcpAsyncTaskRunner(
  options: McpAsyncTaskRunnerOptions = {},
): McpAsyncTaskRunner {
  const resolveHost = options.resolveHost ?? systemResolveHost;
  const isAllowedAddress = options.isAllowedAddress ?? isPublicAddress;
  const transport =
    options.transport ??
    createHttpsWebhookTransport({ resolveHost, isAllowedAddress });
  const maxConcurrent = options.maxConcurrent ?? 8;
  const maxPending = options.maxPending ?? 256;
  const taskTimeoutMs = options.taskTimeoutMs ?? 120_000;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 10_000;
  const deliveryAttempts = Math.max(1, options.deliveryAttempts ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const log: TaskLogger = options.logger ?? logger;
  const queue: QueuedTask[] = [];
  const inflight = new Set<Promise<void>>();
  let pending = 0;
  let running = 0;

  const headersFor = (task: QueuedTask): Record<string, string> => ({
    "Content-Type": "application/json",
    "User-Agent": `bitcoin-stratigraphy-mcp-webhook/${RELEASE_VERSION}`,
    "X-MCP-Task-Id": task.id,
  });

  async function execute(task: QueuedTask): Promise<McpTaskOutcome> {
    const controller = new AbortController();
    const timedOut: McpTaskOutcome = {
      error: {
        code: ErrorCode.InternalError,
        message: `Asynchronous task timed out after ${taskTimeoutMs} ms`,
      },
    };
    const timer = setTimeout(() => controller.abort(), taskTimeoutMs);
    timer.unref?.();
    try {
      return await Promise.race([
        task.execute(controller.signal),
        new Promise<McpTaskOutcome>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(timedOut), {
            once: true,
          }),
        ),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliver(task: QueuedTask, outcome: McpTaskOutcome) {
    const failed = "error" in outcome;
    const payload: McpTaskWebhookPayload = {
      task_id: task.id,
      status: failed ? "failed" : "completed",
      tool: task.tool,
      request_id: task.requestId,
      created_at: new Date(task.createdAt).toISOString(),
      completed_at: new Date(now()).toISOString(),
      ...(failed ? { error: outcome.error } : { result: outcome.result }),
    };
    const body = JSON.stringify(payload);
    // Never log the callback path or query string: either may carry secrets.
    const context = {
      taskId: task.id,
      tool: task.tool,
      webhookHost: task.webhook.host,
      status: payload.status,
    };
    let reason = "delivery error";
    for (let attempt = 1; attempt <= deliveryAttempts; attempt += 1) {
      try {
        const status = await transport({
          url: task.webhook,
          body,
          headers: headersFor(task),
          signal: AbortSignal.timeout(deliveryTimeoutMs),
        });
        if (status >= 200 && status < 300) {
          log.info(
            { ...context, httpStatus: status, attempt },
            "MCP async task webhook delivered",
          );
          return;
        }
        reason = `HTTP ${status}`;
        if (!isRetryableStatus(status)) break;
      } catch (error) {
        if (error instanceof WebhookTargetError) {
          reason = "target rejected";
          break;
        }
        reason = errorReason(error);
      }
      if (attempt < deliveryAttempts) {
        await delay(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    log.warn({ ...context, reason }, "MCP async task webhook delivery failed");
  }

  async function run(task: QueuedTask): Promise<void> {
    let outcome: McpTaskOutcome;
    try {
      outcome = await execute(task);
    } catch (error) {
      log.error(
        { err: error, taskId: task.id, tool: task.tool },
        "MCP async task execution failed",
      );
      outcome = {
        error: {
          code: ErrorCode.InternalError,
          message: "Asynchronous task execution failed",
        },
      };
    } finally {
      // Free the execution slot before a slow callback holds it.
      running -= 1;
      pump();
    }
    try {
      await deliver(task, outcome);
    } finally {
      pending -= 1;
    }
  }

  function pump(): void {
    while (running < maxConcurrent && queue.length > 0) {
      const task = queue.shift()!;
      running += 1;
      const work: Promise<void> = run(task).finally(() => {
        inflight.delete(work);
      });
      inflight.add(work);
    }
  }

  return {
    hasCapacity: () => pending < maxPending,
    async checkWebhookTarget(webhookUrl) {
      const problem = webhookUrlProblem(webhookUrl);
      if (problem) throw new WebhookTargetError(problem);
      await resolvePublicAddresses(
        bareHostname(new URL(webhookUrl)),
        resolveHost,
        isAllowedAddress,
      );
    },
    accept({ tool, webhookUrl, requestId, execute: work }) {
      const task: QueuedTask = {
        id: randomUUID(),
        tool,
        webhook: new URL(webhookUrl),
        requestId: requestId ?? null,
        createdAt: now(),
        execute: work,
      };
      pending += 1;
      queue.push(task);
      log.info(
        { taskId: task.id, tool, webhookHost: task.webhook.host },
        "MCP async task accepted",
      );
      // Start after the 202 acknowledgement has been written.
      setImmediate(pump);
      return {
        task_id: task.id,
        status: "pending",
        tool,
        created_at: new Date(task.createdAt).toISOString(),
      };
    },
    async drain() {
      while (pending > 0) {
        if (inflight.size === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

/**
 * Runs one tools/call against a fresh SDK server over an in-memory pair and
 * returns its JSON-RPC result or error, exactly as a synchronous call would.
 */
export async function runMcpToolCallInMemory(
  createServer: () => McpServer,
  params: { name: string; arguments: Record<string, unknown> },
  signal: AbortSignal,
): Promise<McpTaskOutcome> {
  const server = createServer();
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const id = 1;
  const closed: McpTaskOutcome = {
    error: {
      code: ErrorCode.InternalError,
      message: "MCP server closed before responding",
    },
  };
  const reply = new Promise<McpTaskOutcome>((resolve) => {
    client.onmessage = (message) => {
      if (isJSONRPCResultResponse(message) && message.id === id) {
        resolve({ result: message.result as Record<string, unknown> });
      } else if (isJSONRPCErrorResponse(message) && message.id === id) {
        resolve({ error: { ...message.error } });
      }
    };
    client.onclose = () => resolve(closed);
    signal.addEventListener("abort", () => resolve(closed), { once: true });
  });
  try {
    await server.connect(transport);
    await client.start();
    await client.send({ jsonrpc: "2.0", id, method: "tools/call", params });
    return await reply;
  } finally {
    // Closing the server aborts the handler's own signal after a timeout.
    for (const close of [() => client.close(), () => server.close()]) {
      try {
        await close();
      } catch {
        // Cleanup failures never change the delivered outcome.
      }
    }
  }
}
