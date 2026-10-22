// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  verify,
  type KeyObject,
} from "node:crypto";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { pool } from "@workspace/db";
import {
  McpTasksExtension,
  TASKS_EXTENSION,
} from "../../src/lib/mcp-tasks-extension";
import {
  memoryMcpTaskStore,
  postgresMcpTaskStore,
} from "../../src/lib/mcp-task-store";
import { verifyToolResponse } from "../../src/lib/mcp-response-signature";
import {
  requestTraceparent,
  validTraceparent,
} from "../../src/lib/trace-context";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import {
  MCP_ASYNC_TOOL_NAMES,
  createHttpsWebhookTransport,
  createMcpAsyncTaskRunner,
  isPublicAddress,
  webhookUrlProblem,
  type McpAsyncTaskRunner,
  type McpAsyncTaskRunnerOptions,
  type McpTaskWebhookPayload,
  type ResolveHost,
} from "../../src/lib/mcp-async-tasks";
import { ASYNC_WEBHOOK_DESCRIPTION_SUFFIX } from "../../src/lib/stratigraphy-tool-descriptions";
import { attenuateSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import {
  indexedContractTestFixture,
  mcpToolDefinitions,
  registerMcpRoute,
} from "../../src/routes/mcp";
import { registerToolIntegrityRoute } from "../../src/routes/tool-integrity";
import type { PrimaryStratigraphyBackend } from "../../src/services/primaryStratigraphy";
import type { SettlementRouter } from "../../src/services/settlement";

// Zero-configuration signing: runners and the integrity manifest both default
// to the tool-integrity key. Pin it for this process so no key file is written.
const integrityKeyBefore = process.env.TOOL_INTEGRITY_PRIVATE_KEY;
process.env.TOOL_INTEGRITY_PRIVATE_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

// Test-only DNS: the receiver host maps to loopback, which only this test's
// address policy permits; every other answer follows the production rule.
const HOOK_HOST = "hooks.agent.test";
const PRIVATE_HOST = "intranet.agent.test";
const MIXED_HOST = "mixed.agent.test";
const resolveHost: ResolveHost = async (hostname) => {
  if (hostname === HOOK_HOST) return [{ address: "127.0.0.1", family: 4 }];
  if (hostname === PRIVATE_HOST) return [{ address: "10.0.0.7", family: 4 }];
  if (hostname === MIXED_HOST) {
    return [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
  }
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: "ENOTFOUND",
  });
};
const isAllowedAddress = (address: string) =>
  address === "127.0.0.1" || isPublicAddress(address);

type LogEntry = { level: string; fields: unknown; message: unknown };
const logs: LogEntry[] = [];
const testLogger = {
  info: (fields: unknown, message?: unknown) =>
    void logs.push({ level: "info", fields, message }),
  warn: (fields: unknown, message?: unknown) =>
    void logs.push({ level: "warn", fields, message }),
  error: (fields: unknown, message?: unknown) =>
    void logs.push({ level: "error", fields, message }),
} as unknown as NonNullable<McpAsyncTaskRunnerOptions["logger"]>;

function testRunner(
  overrides: McpAsyncTaskRunnerOptions = {},
): McpAsyncTaskRunner {
  return createMcpAsyncTaskRunner({
    resolveHost,
    isAllowedAddress,
    transport: createHttpsWebhookTransport({
      resolveHost,
      isAllowedAddress,
      request: http.request,
    }),
    retryDelayMs: 0,
    logger: testLogger,
    ...overrides,
  });
}

type Delivery = {
  path: string;
  headers: IncomingHttpHeaders;
  /** Exact bytes received: the signature covers these, not a re-serialization. */
  raw: Buffer;
  body: McpTaskWebhookPayload;
};
const deliveries: Delivery[] = [];
const receiverStatuses: number[] = [];
const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    deliveries.push({
      path: req.url ?? "",
      headers: req.headers,
      raw,
      body: JSON.parse(raw.toString("utf8")),
    });
    res.statusCode = receiverStatuses.shift() ?? 204;
    res.end();
  });
});
let receiverPort = 0;
const hookUrl = (path = "/mcp/callbacks") =>
  `https://${HOOK_HOST}:${receiverPort}${path}`;

const invoices = new Map<
  string,
  { preimage: string; amountMsats: number; description: string }
>();
let invoiceCount = 0;
const settlementRouter: SettlementRouter = {
  isConfigured: () => true,
  activeProvider: () => "async-test",
  circuitState: () => "closed",
  createInvoice: async (input) => {
    const preimage = (++invoiceCount).toString(16).padStart(64, "0");
    const paymentHash = sha256Hex(Buffer.from(preimage, "hex"));
    invoices.set(paymentHash, {
      preimage,
      amountMsats: input.amountMsats,
      description: input.description,
    });
    return {
      invoice: `lnbc${input.amountMsats}asynctest`,
      paymentHash,
      provider: "async-test",
    };
  },
  verifyPayment: async (input) => {
    const issued = invoices.get(input.paymentHash);
    return issued &&
      issued.preimage === input.preimage &&
      issued.amountMsats === input.expectedAmountMsats &&
      issued.description === input.expectedDescription &&
      input.expectedProvider === "async-test" &&
      input.asset === "btc-lightning"
      ? { settledAt: Date.now(), provider: "async-test" }
      : "invalid";
  },
};

// The backend records every call and can be held or failed on demand.
const backendCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let held: Promise<void> | undefined;
let failRangeWith: string | undefined;
const backend: PrimaryStratigraphyBackend = async (tool, args) => {
  backendCalls.push({ tool, args });
  if (held) await held;
  if (failRangeWith !== undefined && tool === "stratigraphy.get_range") {
    throw new RangeError(failRangeWith);
  }
  return indexedContractTestFixture(tool, args);
};
function hold(): () => void {
  let resolveHeld!: () => void;
  held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const release = () => {
    clearTimeout(safety);
    held = undefined;
    resolveHeld();
  };
  // A regression that awaits the held fetch inline must fail, not hang.
  const safety = setTimeout(release, 5_000);
  safety.unref();
  return release;
}
const bounded = { timeout: 30_000 };

const servers: Server[] = [];
const pollingStore = memoryMcpTaskStore();
const pollingExtension = new McpTasksExtension(pollingStore);
async function startApp(runner: McpAsyncTaskRunner): Promise<{ url: string }> {
  const app = express();
  app.use(
    express.json({
      verify(req, _res, buffer) {
        (req as express.Request & { rawBody?: Buffer }).rawBody =
          Buffer.from(buffer);
      },
    }),
  );
  registerMcpRoute(app, {
    stratigraphyBackend: backend,
    settlementRouter,
    sessionSecret: "async-webhook-secret",
    x402ResourceServer: null,
    revocationStore: createMemoryMacaroonRevocationStore(),
    asyncTaskRunner: runner,
    tasksExtension: pollingExtension,
  });
  // Default key, as for a runner without signingKey: receivers pin this one.
  registerToolIntegrityRoute(app, mcpToolDefinitions);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  };
}

const runner = testRunner();
let endpoint = "";

before(async () => {
  receiver.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => receiver.once("listening", resolve));
  receiverPort = (receiver.address() as AddressInfo).port;
  endpoint = (await startApp(runner)).url;
});

after(async () => {
  await runner.drain();
  await Promise.all(
    [...servers, receiver].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await pool.end();
  if (integrityKeyBefore === undefined) {
    delete process.env.TOOL_INTEGRITY_PRIVATE_KEY;
  } else {
    process.env.TOOL_INTEGRITY_PRIVATE_KEY = integrityKeyBefore;
  }
});

type RpcBody = {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: Record<string, any> };
  [key: string]: any;
};

const legacyHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": LEGACY,
};

function call(
  id: string | number,
  name: string,
  args: Record<string, unknown>,
  era: "legacy" | "stateless" = "legacy",
) {
  return {
    era,
    body: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(era === "stateless"
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : {}),
      },
    },
    headers:
      era === "stateless"
        ? {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": MODERN,
            "Mcp-Method": "tools/call",
            "Mcp-Name": name,
          }
        : legacyHeaders,
  };
}

async function post(
  message: ReturnType<typeof call>,
  authorization?: string,
  url = endpoint,
): Promise<{ response: Response; body?: RpcBody }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...message.headers,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(message.body),
  });
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as RpcBody) : undefined };
}

/** Requests the 402 challenge and returns a credential for that invoice. */
async function paidCredential(
  message: ReturnType<typeof call>,
  url = endpoint,
): Promise<{ authorization: string; macaroon: string; preimage: string }> {
  const challenge = await post(message, undefined, url);
  assert.equal(challenge.response.status, 402, JSON.stringify(challenge.body));
  const offer = (
    challenge.body?.error?.data?.macaroon
      ? challenge.body.error.data
      : challenge.body
  ) as { macaroon: string; payment_hash: string };
  const payment = invoices.get(offer.payment_hash);
  assert.ok(payment, "challenge must reference an issued invoice");
  return {
    authorization: `L402 ${offer.macaroon}:${payment.preimage}`,
    macaroon: offer.macaroon,
    preimage: payment.preimage,
  };
}

function pollingCall(id: number, name: string, args: Record<string, unknown>) {
  const message = call(id, name, args, "stateless");
  message.body.params._meta!["io.modelcontextprotocol/clientCapabilities"] = {
    extensions: { [TASKS_EXTENSION]: {} },
  };
  return message;
}

function taskMessage(id: number, method: string, taskId: string, extra = {}) {
  return {
    body: {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        taskId,
        ...extra,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { [TASKS_EXTENSION]: {} },
          },
        },
      },
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": method,
      "Mcp-Name": taskId,
    },
  } as unknown as ReturnType<typeof call>;
}

async function completedTask(taskId: string) {
  for (let i = 0; i < 100; i++) {
    const response = await post(taskMessage(1001, "tasks/get", taskId));
    assert.equal(response.response.status, 200, JSON.stringify(response.body));
    if (response.body?.result?.status !== "working")
      return response.body!.result!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Task did not finish");
}

test("traceparent extraction accepts HTTP and MCP metadata without mutating signed bytes", () => {
  const context = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const body = { params: { _meta: { traceparent: context } } };
  const req = { body, header: () => undefined } as unknown as express.Request;
  const before = JSON.stringify(body);
  assert.equal(requestTraceparent(req), context);
  assert.equal(JSON.stringify(body), before);
  assert.equal(
    requestTraceparent({
      ...req,
      header: () => context,
    } as unknown as express.Request),
    context,
  );
  for (const value of [
    context.replace("00-", "ff-"),
    context.toUpperCase(),
    "garbage",
    "00-" + "0".repeat(32) + "-00f067aa0ba902b7-01",
    context + "-extra",
  ]) {
    assert.equal(validTraceparent(value), false, value);
  }
});

test(
  "Tasks polling returns a durable handle and an Ed25519 signed completed result",
  bounded,
  async () => {
    const message = pollingCall(1002, "stratigraphy.get_range", {
      startTarget: "919712",
    });
    const credential = await paidCredential(message);
    const release = hold();
    const created = await post(message, credential.authorization);
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    const task = created.body?.result!;
    assert.equal(task.resultType, "task");
    assert.equal(task.status, "working");
    assert.ok(task.pollIntervalMs > 0);
    assert.ok(
      await pollingStore.get(task.taskId),
      "persisted before acknowledgement",
    );
    const working = await post(taskMessage(1013, "tasks/get", task.taskId));
    assert.equal(
      working.body?.result?.status,
      "working",
      "fetch is still held after acknowledgement",
    );
    release();
    const completed = await completedTask(task.taskId);
    assert.equal(completed.resultType, "complete");
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.ok(
      verifyToolResponse(
        "stratigraphy.get_range",
        completed.result,
        await manifestPublicKey(),
      ),
      "final tool result must verify against the pinned server key",
    );
    assert.doesNotMatch(JSON.stringify(completed), /preimage|macaroon/);
  },
);

test(
  "input_required correction uses tasks/update without bypassing payment",
  bounded,
  async () => {
    const invoiceStart = invoiceCount;
    const invalid = await post(
      pollingCall(1003, "stratigraphy.get_range", { startTarget: 42 }),
    );
    assert.equal(
      invalid.body?.result?.status,
      "input_required",
      JSON.stringify(invalid.body),
    );
    assert.equal(invoiceCount, invoiceStart);
    const task = invalid.body!.result!;
    const current = await post(taskMessage(1004, "tasks/get", task.taskId));
    const key = Object.keys(current.body!.result!.inputRequests)[0]!;
    const update = taskMessage(1005, "tasks/update", task.taskId, {
      inputResponses: {
        [key]: {
          action: "accept",
          content: { arguments: JSON.stringify({ startTarget: "919712" }) },
        },
      },
    });
    const credential = await paidCredential(update);
    const accepted = await post(update, credential.authorization);
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body?.result?.resultType, "complete");
    assert.equal((await completedTask(task.taskId)).status, "completed");
    const callsBefore = backendCalls.length;
    const repeated = await post(update, credential.authorization);
    assert.equal(repeated.response.status, 200);
    assert.equal(
      backendCalls.length,
      callsBefore,
      "replayed input must not execute twice",
    );
  },
);

test(
  "Tasks cancellation, missing capabilities, unknown handles, and no enumeration",
  bounded,
  async () => {
    const task = await pollingExtension.create(
      "proof.submit",
      {},
      "Correct input",
    );
    const cancelled = await post(
      taskMessage(1006, "tasks/cancel", task.taskId),
    );
    assert.equal(cancelled.body?.result?.resultType, "complete");
    assert.equal(
      (await post(taskMessage(1007, "tasks/get", task.taskId))).body?.result
        ?.status,
      "cancelled",
    );
    const unknown = await post(taskMessage(1008, "tasks/get", "x".repeat(43)));
    assert.equal(unknown.body?.error?.code, -32602);
    const missing = taskMessage(1009, "tasks/get", task.taskId);
    missing.body.params._meta!["io.modelcontextprotocol/clientCapabilities"] =
      {};
    assert.equal((await post(missing)).body?.error?.code, -32021);
    const listed = await post(taskMessage(1010, "tasks/list", task.taskId));
    assert.ok([-32601, -32020].includes(listed.body?.error?.code ?? 0));
    const mismatched = taskMessage(1011, "tasks/get", task.taskId);
    mismatched.headers["Mcp-Name"] = "wrong";
    assert.equal((await post(mismatched)).body?.error?.code, -32020);
  },
);

test(
  "cancelling an in-flight task persists cancellation and never releases its later result",
  bounded,
  async () => {
    const message = pollingCall(1014, "stratigraphy.get_range", {
      startTarget: "919712",
    });
    const credential = await paidCredential(message);
    const release = hold();
    try {
      const created = await post(message, credential.authorization);
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      const taskId = created.body!.result!.taskId;
      await post(taskMessage(1015, "tasks/cancel", taskId));
      release();
      const state = await completedTask(taskId);
      assert.equal(state.status, "cancelled");
      assert.equal(state.result, undefined);
    } finally {
      release();
    }
  },
);

test(
  "durable task stores survive new instances and reject competing revisions",
  bounded,
  async () => {
    const store = postgresMcpTaskStore();
    const extension = new McpTasksExtension(store);
    const task = await extension.create("proof.submit", {}, "Correct input");
    try {
      const other = new McpTasksExtension(postgresMcpTaskStore());
      assert.equal((await other.get(task.taskId))?.status, "input_required");
      const updated = { ...task, revision: 1, status: "cancelled" as const };
      const outcomes = await Promise.all([
        store.replace(updated, 0),
        other.store.replace(updated, 0),
      ]);
      assert.deepEqual(outcomes.sort(), [false, true]);
      assert.equal((await other.get(task.taskId))?.status, "cancelled");
    } finally {
      await store.remove(task.taskId);
    }
  },
);

test("expired handles disappear and interrupted charged tasks are never replayed", async () => {
  const store = memoryMcpTaskStore();
  const extension = new McpTasksExtension(store);
  const task = await extension.create("proof.submit", {});
  await store.replace(
    {
      ...task,
      revision: 1,
      lastUpdatedAt: new Date(Date.now() - 220_000).toISOString(),
    },
    0,
  );
  assert.equal((await extension.get(task.taskId))?.status, "failed");
  const stale = await extension.get(task.taskId);
  await store.replace(
    {
      ...stale!,
      revision: stale!.revision + 1,
      createdAt: new Date(Date.now() - 3_700_000).toISOString(),
    },
    stale!.revision,
  );
  assert.equal(await extension.get(task.taskId), undefined);
});

test(
  "explicit webhook_url retains v1a push delivery for Tasks-capable clients",
  bounded,
  async () => {
    const before = deliveries.length;
    const message = pollingCall(1012, "stratigraphy.get_range", {
      startTarget: "919712",
      webhook_url: hookUrl("/tasks-capable-callback"),
    });
    const credential = await paidCredential(message);
    const accepted = await post(message, credential.authorization);
    assert.equal(accepted.response.status, 202);
    await runner.drain();
    assert.equal(deliveries.length, before + 1);
    assert.match(
      String(deliveries.at(-1)!.headers["webhook-signature"]),
      /^v1a,/,
    );
    // This test's receiver state must not change the legacy webhook fixtures.
    deliveries.splice(before);
  },
);

function assertAcknowledgement(
  body: RpcBody | undefined,
  id: string | number,
  tool: string,
): { task_id: string; created_at: string } {
  assert.equal(body?.jsonrpc, "2.0");
  assert.equal(body?.id, id);
  assert.equal(body?.error, undefined);
  const ack = body?.result as Record<string, string>;
  assert.deepEqual(Object.keys(ack).sort(), [
    "created_at",
    "status",
    "task_id",
    "tool",
  ]);
  assert.match(ack.task_id!, UUID);
  assert.equal(ack.status, "pending");
  assert.equal(ack.tool, tool);
  assert.ok(Number.isFinite(Date.parse(ack.created_at!)));
  return { task_id: ack.task_id!, created_at: ack.created_at! };
}

/** The key a receiver pins: fetched from the app's integrity manifest. */
async function manifestPublicKey(url = endpoint): Promise<KeyObject> {
  const response = await fetch(new URL("/.well-known/integrity.json", url));
  assert.equal(response.status, 200);
  const manifest = (await response.json()) as {
    algorithm: string;
    server_public_key: string;
  };
  assert.equal(manifest.algorithm, "Ed25519");
  return createPublicKey(manifest.server_public_key);
}

/**
 * Independent Standard Webhooks check: accept a space-delimited "v1a,<base64>"
 * Ed25519 entry over `${id}.${timestamp}.` followed by the raw body bytes.
 */
function webhookSignatureValid(
  publicKey: KeyObject,
  id: string,
  timestamp: string,
  raw: Buffer,
  signatureHeader: string,
): boolean {
  const content = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    raw,
  ]);
  return signatureHeader.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    return (
      version === "v1a" &&
      signature !== undefined &&
      verify(null, content, publicKey, Buffer.from(signature, "base64"))
    );
  });
}

function header(delivery: Delivery, name: string): string {
  const value = delivery.headers[name];
  assert.equal(typeof value, "string", name);
  return value as string;
}

/** Asserts the Standard Webhooks headers and signature; returns the timestamp. */
function assertSignedDelivery(
  delivery: Delivery,
  publicKey: KeyObject,
): number {
  const id = header(delivery, "webhook-id");
  const timestamp = header(delivery, "webhook-timestamp");
  const signature = header(delivery, "webhook-signature");
  assert.equal(id, delivery.body.task_id);
  assert.equal(id, header(delivery, "x-mcp-task-id"));
  assert.match(timestamp, /^[1-9]\d*$/);
  assert.ok(
    Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300,
    "timestamp within the five-minute tolerance",
  );
  // A single entry: the asymmetric identifier and a 64-byte Ed25519 signature.
  assert.match(signature, /^v1a,[A-Za-z0-9+/]{86}==$/);
  assert.equal(Buffer.from(signature.slice(4), "base64").length, 64);
  assert.ok(
    webhookSignatureValid(publicKey, id, timestamp, delivery.raw, signature),
    "signature verifies against the manifest public key",
  );
  return Number(timestamp);
}

const proofArguments = {
  proof: {
    piA: ["1", "2", "1"],
    piB: [
      ["1", "2"],
      ["3", "4"],
      ["1", "0"],
    ],
    piC: ["5", "6", "1"],
  },
  publicSignals: ["920000", "1", "1789776000000", "12583", "1"],
  snapshotDigest: "1",
};

test(
  "get_range with webhook_url answers 202 before the fetch, then POSTs the synchronous result",
  bounded,
  async () => {
    const webhookUrl = hookUrl("/mcp/callbacks?token=s3cr3t-callback-token");
    const message = call(41, "stratigraphy.get_range", {
      startTarget: "919712",
      webhook_url: webhookUrl,
    });
    const invoicesBefore = invoiceCount;
    const credential = await paidCredential(message);
    assert.equal(invoiceCount, invoicesBefore + 1);
    // The unpaid challenge validated the range without the callback URL and
    // dispatched nothing.
    await runner.drain();
    assert.equal(deliveries.length, 0);
    assert.ok(backendCalls.every(({ args }) => !("webhook_url" in args)));

    const release = hold();
    const callsBefore = backendCalls.length;
    let ack: { task_id: string; created_at: string };
    try {
      const accepted = await post(message, credential.authorization);
      assert.equal(
        accepted.response.status,
        202,
        JSON.stringify(accepted.body),
      );
      assert.equal(accepted.response.headers.get("cache-control"), "no-store");
      ack = assertAcknowledgement(accepted.body, 41, "stratigraphy.get_range");
      // The range fetch is still held, so nothing can have been delivered.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(deliveries.length, 0);
    } finally {
      release();
    }
    await runner.drain();

    assert.equal(deliveries.length, 1);
    const [delivery] = deliveries;
    assert.equal(delivery!.path, "/mcp/callbacks?token=s3cr3t-callback-token");
    assert.equal(delivery!.headers.host, `${HOOK_HOST}:${receiverPort}`);
    assert.equal(delivery!.headers["content-type"], "application/json");
    assert.equal(delivery!.headers["x-mcp-task-id"], ack.task_id);
    assert.match(
      delivery!.headers["user-agent"] ?? "",
      /^bitcoin-stratigraphy-mcp-webhook\/\S+$/,
    );

    // Standard Webhooks: Ed25519 (v1a) over task_id.timestamp.raw_body,
    // verified with the public key a receiver fetches from integrity.json.
    const publicKey = await manifestPublicKey();
    assert.equal(header(delivery!, "webhook-id"), ack.task_id);
    const signedAt = assertSignedDelivery(delivery!, publicKey);
    assert.ok(signedAt >= Math.floor(Date.parse(ack.created_at) / 1000));
    const signature = header(delivery!, "webhook-signature");
    const tamperedBody = Buffer.from(
      delivery!.raw.toString("utf8").replace('"completed"', '"failed"'),
    );
    assert.notDeepEqual(tamperedBody, delivery!.raw);
    for (const [id, timestamp, raw, signed] of [
      [ack.task_id, String(signedAt), tamperedBody, signature],
      [ack.task_id, String(signedAt + 1), delivery!.raw, signature],
      [randomUUID(), String(signedAt), delivery!.raw, signature],
      // v1 is the HMAC-SHA256 identifier; an Ed25519 value is only valid as v1a.
      [ack.task_id, String(signedAt), delivery!.raw, `v1${signature.slice(3)}`],
    ] as const) {
      assert.equal(
        webhookSignatureValid(publicKey, id, timestamp, raw, signed),
        false,
      );
    }
    const otherKey = createPublicKey(generateKeyPairSync("ed25519").privateKey);
    assert.equal(
      webhookSignatureValid(
        otherKey,
        ack.task_id,
        String(signedAt),
        delivery!.raw,
        signature,
      ),
      false,
    );
    const payload = delivery!.body;
    assert.deepEqual(Object.keys(payload).sort(), [
      "completed_at",
      "created_at",
      "request_id",
      "result",
      "status",
      "task_id",
      "tool",
    ]);
    assert.equal(payload.task_id, ack.task_id);
    assert.equal(payload.status, "completed");
    assert.equal(payload.tool, "stratigraphy.get_range");
    assert.equal(payload.request_id, 41);
    assert.equal(payload.created_at, ack.created_at);
    assert.ok(
      Date.parse(payload.completed_at) >= Date.parse(payload.created_at),
    );
    // The background fetch ran once, with parsed arguments and no callback URL.
    assert.deepEqual(backendCalls.slice(callsBefore), [
      {
        tool: "stratigraphy.get_range",
        args: {
          startTarget: "919712",
          endTarget: "latest",
          limit: 50,
          format: "compact",
        },
      },
    ]);

    // Without webhook_url the same call is answered synchronously, with the
    // identical MCP result, and nothing more is dispatched.
    const syncMessage = call(42, "stratigraphy.get_range", {
      startTarget: "919712",
    });
    const sync = await post(
      syncMessage,
      (await paidCredential(syncMessage)).authorization,
    );
    assert.equal(sync.response.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body?.id, 42);
    assert.ok(sync.body?.result?.structuredContent);
    assert.ok(sync.body?.result?._meta?.responseSignature);
    assert.equal(payload.result?._meta?.responseSignature, undefined);
    // Only synchronous replies get the new envelope; compare all other bytes.
    const syncPayload = structuredClone(sync.body!.result!);
    delete syncPayload._meta.responseSignature;
    if (Object.keys(syncPayload._meta).length === 0) delete syncPayload._meta;
    assert.deepEqual(payload.result, syncPayload);
    await runner.drain();
    assert.equal(deliveries.length, 1);

    // Logs carry the task, tool and host, never the callback path or token.
    const logged = JSON.stringify(logs);
    assert.match(logged, new RegExp(ack.task_id));
    assert.ok(logged.includes(`${HOOK_HOST}:${receiverPort}`));
    assert.doesNotMatch(logged, /s3cr3t-callback-token|\/mcp\/callbacks/);
  },
);

test(
  "proof.submit verifies in the background, and omits the callback from the archive",
  bounded,
  async () => {
    const deliveredBefore = deliveries.length;
    const message = call(51, "proof.submit", {
      ...proofArguments,
      webhook_url: hookUrl("/proofs?secret=proof-callback-secret"),
    });
    const accepted = await post(
      message,
      (await paidCredential(message)).authorization,
    );
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
    const ack = assertAcknowledgement(accepted.body, 51, "proof.submit");
    await runner.drain();

    assert.equal(deliveries.length, deliveredBefore + 1);
    const payload = deliveries.at(-1)!.body;
    assert.equal(payload.task_id, ack.task_id);
    assert.equal(payload.status, "completed");
    assert.equal(payload.tool, "proof.submit");
    const structured = payload.result?.structuredContent as Record<
      string,
      unknown
    >;
    assert.equal(structured.status, "invalid");
    assert.equal(structured.attestationStatus, "not_broadcast_invalid_proof");
    assert.match(String(structured.jobId), UUID);
    assert.match(String(structured.proofHash), /^0x[0-9a-f]{64}$/);
    const content = payload.result?.content as Array<{ text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), structured);

    // The archived proof record never stores the caller's callback.
    const lookup = call(53, "proof.get_by_hash", { hash: structured.jobId });
    const archived = await post(
      lookup,
      (await paidCredential(lookup)).authorization,
    );
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body?.result?.structuredContent?.status, "invalid");
    assert.doesNotMatch(
      JSON.stringify(archived.body),
      /webhook_url|proof-callback-secret/,
    );

    // Without webhook_url, proof.submit still answers synchronously.
    const syncMessage = call(52, "proof.submit", proofArguments);
    const sync = await post(
      syncMessage,
      (await paidCredential(syncMessage)).authorization,
    );
    assert.equal(sync.response.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body?.result?.structuredContent?.status, "invalid");
    await runner.drain();
    assert.equal(deliveries.length, deliveredBefore + 1);
  },
);

test(
  "2026-07-28 stateless calls get the same 202 and an era-framed callback",
  bounded,
  async () => {
    const deliveredBefore = deliveries.length;
    const message = call(
      "61",
      "stratigraphy.range",
      { startTarget: "919712", limit: 2, webhook_url: hookUrl("/stateless") },
      "stateless",
    );
    const accepted = await post(
      message,
      (await paidCredential(message)).authorization,
    );
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.response.headers.get("mcp-session-id"), null);
    const ack = assertAcknowledgement(
      accepted.body,
      "61",
      "stratigraphy.get_range",
    );
    await runner.drain();
    assert.equal(deliveries.length, deliveredBefore + 1);
    const payload = deliveries.at(-1)!.body;
    assert.equal(payload.task_id, ack.task_id);
    assert.equal(payload.request_id, "61");
    assert.equal(payload.status, "completed");
    assert.equal(payload.result?.resultType, "complete");
    assert.equal(
      (payload.result?._meta as Record<string, { name?: string }>)[
        "io.modelcontextprotocol/serverInfo"
      ]?.name,
      "bitcoin-stratigraphy",
    );
    assert.equal(
      (payload.result?.structuredContent as { count?: number }).count,
      2,
    );
  },
);

test(
  "unsafe or unsupported callbacks are refused before any invoice and nothing is dispatched",
  bounded,
  async () => {
    const invoicesBefore = invoiceCount;
    const deliveredBefore = deliveries.length;
    // Schema-level refusals: JSON-RPC invalid params, no L402 challenge.
    for (const [name, webhookUrl] of [
      ["stratigraphy.get_range", `http://${HOOK_HOST}/plain-http`],
      ["stratigraphy.get_range", "https://127.0.0.1/loopback"],
      ["stratigraphy.get_range", "https://[::1]/loopback"],
      ["stratigraphy.get_range", "https://169.254.169.254/latest/meta-data"],
      ["stratigraphy.get_range", "https://2130706433/decimal-loopback"],
      ["stratigraphy.get_range", "https://localhost/hook"],
      ["stratigraphy.get_range", "https://metadata/computeMetadata"],
      ["stratigraphy.get_range", "https://db.internal/hook"],
      ["proof.submit", `https://user:pass@${HOOK_HOST}/credentials`],
      ["proof.submit", `https://${HOOK_HOST}/${"a".repeat(2_048)}`],
      ["stratigraphy.get_diff", hookUrl("/unsupported-tool")],
    ] as const) {
      const args =
        name === "proof.submit"
          ? { ...proofArguments, webhook_url: webhookUrl }
          : name === "stratigraphy.get_diff"
            ? { fromTarget: "919712", webhook_url: webhookUrl }
            : { startTarget: "919712", webhook_url: webhookUrl };
      const refused = await post(call(71, name, args));
      assert.ok(
        [200, 400].includes(refused.response.status),
        `${webhookUrl}: ${refused.response.status}`,
      );
      assert.equal(refused.body?.error?.code, -32602, webhookUrl);
      assert.equal(refused.response.headers.get("www-authenticate"), null);
    }
    // DNS-level refusals share one message, whatever the resolver answered.
    for (const host of [PRIVATE_HOST, MIXED_HOST, "missing.agent.test"]) {
      const refused = await post(
        call(72, "stratigraphy.get_range", {
          startTarget: "919712",
          webhook_url: `https://${host}/hook`,
        }),
      );
      assert.equal(refused.response.status, 400, host);
      assert.deepEqual(refused.body, {
        jsonrpc: "2.0",
        id: 72,
        error: {
          code: -32602,
          message: "webhook_url must be a publicly reachable HTTPS endpoint",
        },
      });
    }
    assert.equal(invoiceCount, invoicesBefore);
    await runner.drain();
    assert.equal(deliveries.length, deliveredBefore);
  },
);

test(
  "max_target credentials are checked against fetched heights before acceptance",
  bounded,
  async () => {
    const deliveredBefore = deliveries.length;
    const unbounded = call(81, "stratigraphy.get_range", {
      startTarget: "919856",
      endTarget: "latest",
      webhook_url: hookUrl("/bounded"),
    });
    const { macaroon, preimage } = await paidCredential(unbounded);
    const bounded = attenuateSubscriptionMacaroon(macaroon, [
      "max_target=919856",
    ]);
    assert.ok(bounded);
    const forbidden = await post(unbounded, `L402 ${bounded}:${preimage}`);
    assert.equal(forbidden.response.status, 403);
    const permittedMessage = call(82, "stratigraphy.get_range", {
      startTarget: "919856",
      endTarget: "919856",
      webhook_url: hookUrl("/bounded"),
    });
    const callsBefore = backendCalls.length;
    const accepted = await post(
      permittedMessage,
      `L402 ${bounded}:${preimage}`,
    );
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
    assertAcknowledgement(accepted.body, 82, "stratigraphy.get_range");
    await runner.drain();
    // The pre-acceptance fetch is reused; the background run fetches nothing.
    assert.equal(backendCalls.length, callsBefore + 1);
    assert.equal(deliveries.length, deliveredBefore + 1);
    const payload = deliveries.at(-1)!.body;
    assert.equal(payload.status, "completed");
    assert.equal(
      (payload.result?.structuredContent as { count?: number }).count,
      1,
    );
  },
);

test(
  "background failures are delivered as status failed with the JSON-RPC error",
  bounded,
  async () => {
    const message = call(91, "stratigraphy.get_range", {
      startTarget: "919712",
      webhook_url: hookUrl("/failures"),
    });
    const credential = await paidCredential(message);
    failRangeWith =
      "No captured stratigraphy records match the requested real height/date";
    try {
      const accepted = await post(message, credential.authorization);
      assert.equal(accepted.response.status, 202);
      const ack = assertAcknowledgement(
        accepted.body,
        91,
        "stratigraphy.get_range",
      );
      await runner.drain();
      // Failure callbacks are signed exactly like completed ones.
      assertSignedDelivery(deliveries.at(-1)!, await manifestPublicKey());
      const payload = deliveries.at(-1)!.body;
      assert.equal(payload.task_id, ack.task_id);
      assert.equal(payload.status, "failed");
      assert.equal(payload.result, undefined);
      assert.equal(payload.error?.code, -32602);
      assert.match(
        payload.error?.message ?? "",
        /No captured stratigraphy records match the requested real height\/date/,
      );
    } finally {
      failRangeWith = undefined;
    }
  },
);

test(
  "a full task queue refuses new callbacks before invoicing and recovers",
  bounded,
  async () => {
    const smallRunner = testRunner({ maxPending: 1 });
    const { url } = await startApp(smallRunner);
    const first = call(101, "stratigraphy.get_range", {
      startTarget: "919712",
      webhook_url: hookUrl("/capacity"),
    });
    const credential = await paidCredential(first, url);
    const release = hold();
    try {
      const accepted = await post(first, credential.authorization, url);
      assert.equal(accepted.response.status, 202);
      const invoicesBefore = invoiceCount;
      const refused = await post(
        call(102, "proof.submit", {
          ...proofArguments,
          webhook_url: hookUrl("/capacity"),
        }),
        undefined,
        url,
      );
      assert.equal(refused.response.status, 503);
      assert.equal(refused.response.headers.get("retry-after"), "30");
      assert.equal(refused.body?.error?.code, -32603);
      assert.match(refused.body?.error?.message ?? "", /omit webhook_url/);
      assert.equal(invoiceCount, invoicesBefore);
    } finally {
      release();
    }
    await smallRunner.drain();
    const retried = await post(
      call(103, "proof.submit", {
        ...proofArguments,
        webhook_url: hookUrl("/capacity"),
      }),
      undefined,
      url,
    );
    assert.equal(retried.response.status, 402);
  },
);

test(
  "delivery retries transient failures only, and stalled or crashed tasks report failure",
  bounded,
  async () => {
    // Each clock reading advances one second, so every attempt gets its own time.
    let clock = Date.now();
    const runnerUnderTest = testRunner({
      taskTimeoutMs: 50,
      now: () => (clock += 1_000),
    });
    const completed = async () => ({ result: { ok: true } });
    const deliveredFor = (taskId: string) =>
      deliveries.filter((delivery) => delivery.body.task_id === taskId);

    receiverStatuses.push(503, 429);
    const retried = runnerUnderTest.accept({
      tool: "proof.submit",
      webhookUrl: hookUrl("/retry"),
      requestId: 1,
      execute: completed,
    });
    await runnerUnderTest.drain();
    const attempts = deliveredFor(retried.task_id);
    assert.equal(attempts.length, 3);
    // Retries keep the Webhook-Id and body but are re-signed for a fresh time.
    const publicKey = await manifestPublicKey();
    const signedAt = attempts.map((attempt) =>
      assertSignedDelivery(attempt, publicKey),
    );
    assert.ok(signedAt[0]! < signedAt[1]! && signedAt[1]! < signedAt[2]!);
    assert.equal(
      new Set(attempts.map((attempt) => header(attempt, "webhook-id"))).size,
      1,
    );
    assert.equal(
      new Set(attempts.map((attempt) => attempt.raw.toString("hex"))).size,
      1,
    );
    assert.equal(
      new Set(attempts.map((attempt) => header(attempt, "webhook-signature")))
        .size,
      3,
    );

    receiverStatuses.push(404);
    const rejected = runnerUnderTest.accept({
      tool: "proof.submit",
      webhookUrl: hookUrl("/gone"),
      execute: completed,
    });
    await runnerUnderTest.drain();
    assert.equal(deliveredFor(rejected.task_id).length, 1);
    assert.equal(deliveredFor(rejected.task_id)[0]!.body.request_id, null);

    const stalled = runnerUnderTest.accept({
      tool: "stratigraphy.get_range",
      webhookUrl: hookUrl("/stalled"),
      execute: () => new Promise(() => {}),
    });
    const crashed = runnerUnderTest.accept({
      tool: "stratigraphy.get_range",
      webhookUrl: hookUrl("/crashed"),
      execute: async () => {
        throw new Error("internal detail that must not leak");
      },
    });
    await runnerUnderTest.drain();
    const stalledPayload = deliveredFor(stalled.task_id)[0]!.body;
    assert.equal(stalledPayload.status, "failed");
    assert.equal(stalledPayload.error?.code, -32603);
    assert.match(stalledPayload.error?.message ?? "", /timed out after 50 ms/);
    const crashedPayload = deliveredFor(crashed.task_id)[0]!.body;
    assert.deepEqual(crashedPayload.error, {
      code: -32603,
      message: "Asynchronous task execution failed",
    });

    // A host that later resolves to a reserved address is never contacted.
    const deliveredBefore = deliveries.length;
    runnerUnderTest.accept({
      tool: "proof.submit",
      webhookUrl: `https://${MIXED_HOST}:${receiverPort}/rebound`,
      execute: completed,
    });
    await runnerUnderTest.drain();
    assert.equal(deliveries.length, deliveredBefore);
    assert.ok(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          JSON.stringify(entry.fields).includes("target rejected"),
      ),
    );
  },
);

test(
  "callbacks are never sent unsigned: without a signing key, webhook calls are refused before invoicing",
  bounded,
  async () => {
    const unsigned = testRunner({
      signingKey: () => {
        throw new Error("signing key unavailable");
      },
    });
    const { url } = await startApp(unsigned);
    const invoicesBefore = invoiceCount;
    const deliveredBefore = deliveries.length;
    const refused = await post(
      call(111, "stratigraphy.get_range", {
        startTarget: "919712",
        webhook_url: hookUrl("/unsigned"),
      }),
      undefined,
      url,
    );
    assert.equal(refused.response.status, 503);
    assert.equal(refused.response.headers.get("retry-after"), "30");
    assert.deepEqual(refused.body?.error, {
      code: -32603,
      message:
        "Signed webhook delivery is unavailable; retry later or omit webhook_url for a synchronous result",
    });
    assert.equal(invoiceCount, invoicesBefore);
    // Synchronous calls are unaffected and still receive the 402 challenge.
    const sync = await post(
      call(112, "stratigraphy.get_range", { startTarget: "919712" }),
      undefined,
      url,
    );
    assert.equal(sync.response.status, 402);

    // A task that reaches the runner anyway is dropped, never posted unsigned.
    const dropped = unsigned.accept({
      tool: "proof.submit",
      webhookUrl: hookUrl("/unsigned"),
      execute: async () => ({ result: { ok: true } }),
    });
    await unsigned.drain();
    assert.equal(deliveries.length, deliveredBefore);
    assert.ok(
      logs.some(
        (entry) =>
          entry.level === "warn" &&
          JSON.stringify(entry.fields).includes(dropped.task_id) &&
          JSON.stringify(entry.fields).includes("signing key unavailable"),
      ),
    );

    // Only an Ed25519 private key can sign.
    for (const signingKey of [
      generateKeyPairSync("x25519").privateKey,
      generateKeyPairSync("ed25519").publicKey,
    ]) {
      await assert.rejects(
        testRunner({ signingKey }).checkWebhookTarget(hookUrl("/wrong-key")),
        (error: Error) =>
          error.name === "Error" && /Ed25519 private key/.test(error.message),
      );
    }
  },
);

test(
  "the address policy admits only public unicast destinations",
  bounded,
  async () => {
    for (const address of [
      "8.8.8.8",
      "93.184.216.34",
      "2606:4700:4700::1111",
    ]) {
      assert.equal(isPublicAddress(address), true, address);
    }
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.8",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::7f00:1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::1",
      "not-an-address",
    ]) {
      assert.equal(isPublicAddress(address), false, address);
    }
    for (const url of [
      "https://hooks.example.com/cb?x=1",
      "https://8.8.8.8/hook",
      "https://[2606:4700:4700::1111]/hook",
    ]) {
      assert.equal(webhookUrlProblem(url), undefined, url);
    }
    for (const url of [
      "not a url",
      "http://hooks.example.com/cb",
      "https://user:pass@hooks.example.com/",
      "https://127.0.0.1/",
      "https://0x7f000001/",
      "https://[::ffff:7f00:1]/",
      "https://localhost./",
      "https://printer.local/",
      "https://metadata/",
    ]) {
      assert.equal(typeof webhookUrlProblem(url), "string", url);
    }
    const runnerUnderTest = createMcpAsyncTaskRunner({ resolveHost });
    await assert.rejects(
      runnerUnderTest.checkWebhookTarget(`https://${HOOK_HOST}/loopback`),
      { name: "WebhookTargetError" },
    );
    await assert.rejects(
      runnerUnderTest.checkWebhookTarget(`https://${MIXED_HOST}/mixed`),
      { name: "WebhookTargetError" },
    );
  },
);

test(
  "both tools advertise webhook_url and the verbatim async suffix; no other tool does",
  bounded,
  () => {
    const withWebhook = mcpToolDefinitions
      .filter(
        (tool) =>
          (tool.inputSchema as { properties?: Record<string, unknown> })
            .properties?.webhook_url !== undefined,
      )
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(withWebhook, [...MCP_ASYNC_TOOL_NAMES].sort());
    assert.deepEqual(withWebhook, ["proof.submit", "stratigraphy.get_range"]);
    assert.equal(
      ASYNC_WEBHOOK_DESCRIPTION_SUFFIX,
      " Supports zero-polling asynchronous execution: provide a webhook_url parameter to receive a 202 Accepted response immediately, followed by a server-initiated POST callback containing the final results when processing completes.",
    );
    for (const tool of mcpToolDefinitions) {
      const occurrences =
        tool.description.split(ASYNC_WEBHOOK_DESCRIPTION_SUFFIX).length - 1;
      if (!MCP_ASYNC_TOOL_NAMES.has(tool.name)) {
        assert.equal(occurrences, 0, tool.name);
        continue;
      }
      assert.equal(occurrences, 1, tool.name);
      assert.ok(
        tool.description.endsWith(ASYNC_WEBHOOK_DESCRIPTION_SUFFIX),
        tool.name,
      );
      const schema = tool.inputSchema as {
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };
      const property = schema.properties.webhook_url!;
      assert.equal(property.type, "string");
      assert.equal(property.format, "uri");
      assert.equal(property.maxLength, 2048);
      assert.equal(property.pattern, "^https://");
      assert.deepEqual(property.examples, [
        "https://agent.example.com/mcp/callbacks",
      ]);
      assert.match(String(property.description), /HTTP 202 Accepted/);
      assert.ok(!schema.required.includes("webhook_url"));
    }
  },
);
