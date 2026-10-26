// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import express from "express";
import { verifyEvent, type Event } from "nostr-tools";
import { pool } from "@workspace/db";
import { createReceiptMesh, receiptMesh, receiptProof, RECEIPT_RELAYS, withPipelineReceiptBroadcast } from "../../src/services/receiptMesh";
import { ESCROW_GENESIS, withEscrowLedger, type EscrowSettlementRecord } from "../../src/services/escrowLedger";
import { indexedContractTestFixture, registerMcpRoute } from "../../src/routes/mcp";
import { createMemoryMacaroonUsageStore } from "../../src/lib/macaroon-usage-store";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import type { SettlementRouter } from "../../src/services/settlement";
import type { PipelineReceiptStore } from "../../src/lib/mcp-pipeline";

const key = generateKeyPairSync("ed25519").privateKey;
const secret = "01".padStart(64, "0");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const receipt = (extra = {}) => ({
  status: "completed", request_sha256: "a".repeat(64), amount_sats: 500,
  steps_sha256: "b".repeat(64), finished_at: "2026-10-26T12:00:00.000Z",
  payment_hash: "c".repeat(64), steps: [{ id: "private-id", input: "macaroon-secret" }],
  preimage: "private-preimage", agent_id: "private-agent", ...extra,
});
function harness(options: Parameters<typeof createReceiptMesh>[0] = {}) {
  const messages: { message: string; relay?: string }[] = [];
  const events: Event[] = [];
  let destroyed = 0;
  const mesh = createReceiptMesh({
    enabled: true, privateKey: () => secret, signingKey: () => key,
    log: { warn: (fields: object, message: string) => { messages.push({ ...fields, message }); } } as never,
    poolFactory: () => ({
      publish: (_relays, event) => { events.push(event); return [Promise.resolve("accepted")]; },
      destroy: () => { destroyed++; },
    }),
    ...options,
  });
  return { mesh, messages, events, destroyed: () => destroyed };
}
// Keep a referenced watchdog while intentionally testing unref'ed relay deadlines.
async function drain(mesh: ReturnType<typeof createReceiptMesh>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([mesh.drain(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("mesh failed to drain")), 3_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
after(async () => { await pool.end(); });

test("signs one allowlisted NIP-78 proof for three relays, entirely after scheduling", async () => {
  const h = harness();
  assert.equal(h.mesh.pipeline(receipt()), undefined);
  assert.equal(h.events.length, 0, "no signing or relay work in the caller's stack");
  await drain(h.mesh);
  assert.equal(h.events.length, 3);
  assert.equal(h.destroyed(), 1);
  assert.equal(verifyEvent(h.events[0]), true);
  assert.equal(h.events[0].kind, 30078);
  assert.equal(new Set(h.events.map(event => event.id)).size, 1);
  const proof = JSON.parse(h.events[0].content);
  assert.deepEqual(Object.keys(proof).sort(), [
    "schema", "receipt_type", "task_sha256", "evidence_sha256", "settlement_amount_sats",
    "timestamp", "execution_status", "steps_sha256",
  ].sort());
  assert.equal(proof.task_sha256, "a".repeat(64));
  assert.equal(proof.settlement_amount_sats, 500);
  assert.doesNotMatch(JSON.stringify(h.events), /private-|macaroon-secret|payment_hash|preimage|agent_id/);
  assert.equal(h.messages.length, 0);
});

test("never-settling and rejecting relays time out safely; successful peers still publish", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  let rejectLate!: (error: Error) => void;
  const attempted: string[] = [];
  let destroyed = false;
  const h = harness({
    timeoutMs: 15,
    poolFactory: () => ({
      publish: ([relay]) => {
        attempted.push(relay);
        return [relay === RECEIPT_RELAYS[0]
          ? new Promise<string>((_resolve, reject) => { rejectLate = reject; })
          : relay === RECEIPT_RELAYS[1] ? Promise.reject(new Error("relay down"))
          : Promise.resolve("accepted")];
      },
      destroy: () => { destroyed = true; },
    }),
  });
  try {
    assert.doesNotThrow(() => h.mesh.pipeline(receipt()));
    await drain(h.mesh);
    rejectLate(new Error("late socket failure"));
    await delay(5);
    assert.deepEqual(attempted, [...RECEIPT_RELAYS]);
    assert.equal(destroyed, true);
    assert.equal(h.messages.filter(entry => /timed out/.test(entry.message)).length, 1);
    assert.equal(h.messages.filter(entry => /relay rejected/.test(entry.message)).length, 1);
    assert.equal(unhandled.length, 0);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("pipeline adapter schedules only final paid receipts after a successful durable save", async () => {
  const order: string[] = [];
  let fail = false;
  const store: PipelineReceiptStore = {
    async ready() {}, async reserve() { return true; },
    async save() { if (fail) throw new Error("commit failed"); order.push("saved"); },
  };
  const h = harness();
  const adapter = withPipelineReceiptBroadcast(store, {
    pipeline(value) { order.push("enqueued"); h.mesh.pipeline(value); },
  });
  await adapter.save("key", { status: "running" });
  await adapter.save("key", { status: "completed", receipt: receipt() });
  assert.deepEqual(order, ["saved", "saved", "enqueued"]);
  fail = true;
  await assert.rejects(adapter.save("key", { status: "completed", receipt: receipt() }));
  assert.equal(order.filter(value => value === "enqueued").length, 1);
  await drain(h.mesh);
  assert.equal(h.events.length, 3);
  h.mesh.pipeline(receipt({ amount_sats: 0 }));
  h.mesh.pipeline(receipt({ status: "running" }));
  await drain(h.mesh);
  assert.equal(h.events.length, 3, "no free or unfinished broadcasts");
  h.mesh.pipeline(receipt({ status: "failed" }));
  await drain(h.mesh);
  assert.equal(JSON.parse(h.events.at(-1)!.content).execution_status, "failed");
});

test("single-tool proof is signed and persisted before publication; no raw output is stored", async () => {
  const rows: unknown[][] = [];
  const h = harness({
    database: {
      async query(sql, values) {
        if (sql.startsWith("SELECT")) return { rows: [{ sats_received: 250 }] };
        rows.push(values!);
        return { rows: [] };
      },
    },
  });
  const result = { content: [], structuredContent: { credential: "private-result-value" } };
  h.mesh.single("mesh.get_status", result, "d".repeat(64));
  assert.equal(rows.length, 0);
  await drain(h.mesh);
  assert.equal(rows.length, 1);
  const stored = JSON.parse(String(rows[0][1]));
  assert.equal(stored.amount_sats, 250);
  assert.ok(stored.issuer_attestation);
  assert.doesNotMatch(String(rows[0][1]), /private-result-value|dddddddd/);
  assert.equal(JSON.parse(h.events[0].content).receipt_type, "mcp-single");
});

test("database, missing-key and synchronous transport failures stay inside the background job", async () => {
  const failedDb = harness({ database: { async query() { throw new Error("offline"); } } });
  failedDb.mesh.single("mesh.get_status", { content: [] }, "d".repeat(64));
  await drain(failedDb.mesh);
  assert.equal(failedDb.events.length, 0);
  assert.ok(failedDb.messages.some(entry => /background job failed/.test(entry.message)));
  const absentKey = harness({ privateKey: () => undefined });
  absentKey.mesh.pipeline(receipt());
  await drain(absentKey.mesh);
  assert.equal(absentKey.events.length, 0);
  assert.ok(absentKey.messages.some(entry => /key unavailable/.test(entry.message)));
  const syncThrow = harness({ poolFactory: () => ({
    publish() { throw new Error("socket construction failure"); }, destroy() {},
  }) });
  syncThrow.mesh.pipeline(receipt());
  await drain(syncThrow.mesh);
  assert.equal(syncThrow.messages.length, 3);
});

test("bounded queue skips excess work explicitly without throwing", async () => {
  const h = harness({ maxPending: 1 });
  h.mesh.pipeline(receipt());
  assert.doesNotThrow(() => h.mesh.pipeline(receipt()));
  await drain(h.mesh);
  assert.equal(h.events.length, 3);
  assert.ok(h.messages.some(entry => /queue full/.test(entry.message)));
});

test("RFC 6962 projection hides identities and broadcasts only after COMMIT, never rollback", async () => {
  const settlement: EscrowSettlementRecord = {
    escrowId: "private-escrow", agentId: "private-agent", isAuthenticated: true,
    leafIndex: 1, executionLeafHash: "a".repeat(64), merkleRoot: "b".repeat(64),
    settledAtStrataBlock: 900000, settledAt: "2026-10-26T12:00:00.000Z",
    paymentHash: "c".repeat(64), tollSats: 24, settlementProvider: "coinos",
  };
  const publicProof = receiptProof("rfc6962-escrow", { ...settlement });
  assert.equal(publicProof.merkle_root, settlement.merkleRoot);
  assert.doesNotMatch(JSON.stringify(publicProof), /private-|paymentHash|agentId/);
  const saved = receiptMesh.escrow;
  const operations: string[] = [];
  let fail = false;
  const database = { async connect() { return {
    async query(sql: string) {
      operations.push(sql);
      if (fail && sql === "COMMIT") throw new Error("database down");
      return { rows: [{ genesis: ESCROW_GENESIS, state: null }] };
    },
    release() {},
  }; } };
  receiptMesh.escrow = () => {
    assert.equal(operations.at(-1), "COMMIT");
    operations.push("broadcast");
    throw new Error("scheduling failure is isolated");
  };
  try {
    const operation = async () => ({
      state: { version: 1 as const, contracts: [], leaves: [] }, result: "paid-success", settlement,
    });
    assert.equal(await withEscrowLedger(operation, database as never), "paid-success");
    assert.equal(operations.filter(item => item === "broadcast").length, 1);
    fail = true;
    await assert.rejects(withEscrowLedger(operation, database as never));
    assert.equal(operations.at(-1), "ROLLBACK");
    assert.equal(operations.filter(item => item === "broadcast").length, 1);
  } finally { receiptMesh.escrow = saved; }
});

test("real paid single and pipeline HTTP responses return while every relay is unresponsive", async () => {
  const oldKey = process.env.TOOL_INTEGRITY_PRIVATE_KEY;
  process.env.TOOL_INTEGRITY_PRIVATE_KEY = key.export({ type: "pkcs8", format: "pem" }).toString();
  const h = harness({
    timeoutMs: 300,
    database: { async query(sql) { return { rows: sql.startsWith("SELECT") ? [{ sats_received: 250 }] : [] }; } },
    poolFactory: () => ({ publish: () => [new Promise<string>(() => {})], destroy() {} }),
  });
  const invoices = new Map<string, string>();
  let count = 0;
  const router: SettlementRouter = {
    isConfigured: () => true, activeProvider: () => "mesh-test", circuitState: () => [],
    async createInvoice() {
      const preimage = sha(String(++count));
      const paymentHash = sha(Buffer.from(preimage, "hex"));
      invoices.set(paymentHash, preimage);
      return { invoice: `lnbcmesh${count}`, paymentHash, provider: "mesh-test" };
    },
    async verifyPayment(input) {
      return invoices.get(input.paymentHash) === input.preimage
        ? { provider: "mesh-test", asset: "btc-lightning", settledAt: Date.now() } : "invalid";
    },
  };
  const saved: Record<string, unknown>[] = [];
  const app = express();
  app.use(express.json());
  registerMcpRoute(app, {
    settlementRouter: router, sessionSecret: "mesh-test-session",
    usageStore: createMemoryMacaroonUsageStore(), revocationStore: createMemoryMacaroonRevocationStore(),
    stratigraphyBackend: indexedContractTestFixture,
    meshService: {
      status: () => ({ configuredPeerCount: 0, quorumThreshold: 1, peerCount: 0, pendingBroadcasts: 0 }) as never,
      createConsensus: async () => { throw new Error("not used"); },
    },
    pipelineReceiptStore: withPipelineReceiptBroadcast({
      async ready() {}, async reserve() { return true; }, async save(_key, value) { saved.push(value); },
    }, h.mesh),
    onPaidToolCompleted: (name, result, paymentHash) => h.mesh.single(name, result, paymentHash),
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const post = async (body: unknown, authorization?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json",
        ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mesh.get_status", arguments: {} } };
    for (const body of [call, { jsonrpc: "2.0", id: 2, method: "tools/pipeline", params: { calls: [call] } }]) {
      const challenge = await post(body);
      assert.equal(challenge.status, 402);
      const before = h.messages.length;
      const paid = await post(body, `L402 ${challenge.body.macaroon}:${invoices.get(challenge.body.payment_hash)}`);
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      assert.ok(paid.body.result);
      assert.equal(h.messages.length, before, "HTTP completed before relay timeout handling");
    }
    assert.ok(saved.some(row => row.status === "completed"));
    await drain(h.mesh);
    assert.equal(h.messages.filter(entry => /timed out/.test(entry.message)).length, 6);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (oldKey === undefined) delete process.env.TOOL_INTEGRITY_PRIVATE_KEY;
    else process.env.TOOL_INTEGRITY_PRIVATE_KEY = oldKey;
  }
});
