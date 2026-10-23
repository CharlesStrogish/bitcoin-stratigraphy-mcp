// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { registerEscrowRoutes, assertEscrowMcpRegistryIntegrity } from "./escrow";
import { registerPublicCors } from "../middleware/publicCors";
import { openApiDocument } from "../openapi";
import type {
  EscrowAgentAttribution, EscrowExecutor, EscrowWorkerResult,
} from "../services/escrowBridge";
import { createEscrowRecovery } from "../services/escrowRecovery";
import type { SettlementRouter } from "../services/settlement";
import { createSettlementRouter } from "../services/settlement";
import { createNwcSettlementProvider } from "../services/settlement/nwc-provider";
import { ATTESTATION_DIRECTIVE, OTS_CALENDAR_STANDARD } from "../lib/agent-conversion";
import { canonical, issuerKeyId } from "../lib/article12-signature";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const id = "11111111-1111-4111-8111-111111111111";
const input = { buyer_pubkey: "a".repeat(64), worker_pubkey: "b".repeat(64),
  task_hash: "c".repeat(64), amount_sats: 100 };
const receipt = {
  escrow_id: id, leaf_index: 0, audit_path: [], merkle_root: "d".repeat(64),
  timestamp: "2026-10-09T12:00:00+00:00", tree_size: 1,
  execution_leaf_hash: "e".repeat(64), settled_at_strata_block: 900000,
  receipt_type: "article_12_execution_commitment",
  ots_calendar_standard: OTS_CALENDAR_STANDARD, attestation_directive: ATTESTATION_DIRECTIVE,
};
const paymentGate: RequestHandler = (req, res, next) => {
  if (req.get("authorization") !== "L402 test:proof") {
    res.set("WWW-Authenticate", 'L402 token="test", invoice="ln-test"');
    res.status(402).json({ error: "Payment required" });
  } else next();
};
const tollPreimage = "7".repeat(64);
const tollHash = createHash("sha256").update(Buffer.from(tollPreimage, "hex")).digest("hex");
const tollRouter: SettlementRouter = {
  isConfigured: () => true, activeProvider: () => "coinos", circuitState: () => "closed",
  createInvoice: async () => ({ invoice: "ln-test-toll", paymentHash: tollHash,
    provider: "coinos", asset: "btc-lightning" }),
  verifyPayment: async () => ({ settledAt: 1700000000, provider: "coinos", asset: "btc-lightning" }),
};

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()))));
});

async function serve(options: Parameters<typeof registerEscrowRoutes>[1] = {}) {
  const app = express();
  registerPublicCors(app);
  app.use(express.json());
  registerEscrowRoutes(app, { operatorSecret: "test-operator", paymentGate,
    settlementRouter: tollRouter, sessionSecret: "test-session", ...options });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/escrow`;
}

function post(body: unknown, headers = {}) {
  return { method: "POST", headers: { "content-type": "application/json",
    authorization: "L402 test:proof", "X-Escrow-Operator-Token": "test-operator", ...headers },
    body: JSON.stringify(body) };
}

test("preserves exactly 16 MCP tool schemas and documents all three REST routes", () => {
  assertEscrowMcpRegistryIntegrity();
  assert.equal(Object.keys(openApiDocument["x-mcp-tools"] as object).length, 16);
  const paths = openApiDocument.paths as Record<string, Record<string, { tags: string[] }>>;
  for (const [path, method] of [
    ["/v1/escrow/create", "post"], ["/v1/escrow/settle", "post"],
    ["/v1/escrow/receipt/{escrow_id}", "get"],
  ]) assert.deepEqual(paths[path!]![method!]!.tags, ["Autonomous Escrow"]);
});

test("public toll preview needs no payment or operator token and exposes no escrow secrets", async () => {
  for (const [price, expected] of [[100_000, 20], [1_000_000, 2], [2_000_000, 1]] as const) {
    const base = await serve({ readPrice: async () => price,
      execute: async () => { throw new Error("Quotes must not create contracts"); } });
    const response = await fetch(`${base}/toll`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const quote = await response.json() as Record<string, unknown>;
    assert.equal(quote.toll_fee_sats, expected);
    assert.equal(quote.target_usd, 0.02);
    assert.equal(quote.source, "market");
    assert.equal(Object.hasOwn(quote, "preimage"), false);
  }
});

test("public cumulative ledger counter returns durable totals and never a zero fallback", async () => {
  const base = await serve({ readStats: async () => ({
    ...recoveredLedger, total_settled_sats: 48, total_contracts: 2,
    verified_toll_sats: 48, settled_contracts: 2,
  }) });
  const response = await fetch(`${base}/stats`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const stats = await response.json() as Record<string, unknown>;
  assert.equal(stats.verified_toll_sats, 48);
  assert.equal(stats.total_settled_sats, 48);
  assert.equal(stats.total_contracts, 2);
  assert.match(String(stats.latest_merkle_root), /^[a-f0-9]{64}$/);
  const offline = await serve({ readStats: async () => { throw new Error("database unavailable"); } });
  const unavailable = await fetch(`${offline}/stats`);
  assert.equal(unavailable.status, 503);
  assert.equal(Object.hasOwn(await unavailable.json() as Record<string, unknown>, "verified_toll_sats"), false);
});

const recoveredLedger = { verified_toll_sats: 24, settled_contracts: 1,
  total_settled_sats: 24, total_contracts: 1,
  latest_merkle_root: "d8cd6fe5a388e9422ccc6006969fb01c716291c14b1e85dc4e8a75c2ad134da6",
  genesis_escrow_id: "ba4f25dd-7f16-420c-9264-a16f102fd5a6" };

test("public stats accepts a truly empty ledger without authentication", async () => {
  const empty = { total_settled_sats: 0, total_contracts: 0, latest_merkle_root: null,
    verified_toll_sats: 0, settled_contracts: 0, genesis_escrow_id: "" };
  const base = await serve({ readStats: async () => empty });
  const response = await fetch(`${base}/stats`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), empty);
});

async function untilTrue(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("escrow routes wait for startup ledger recovery and never serve an unrecovered counter", async () => {
  let finishRecovery: ((result: EscrowWorkerResult) => void) | undefined;
  let calls = 0;
  const execute: EscrowExecutor = async (operation) => {
    assert.equal(operation, "stats");
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { finishRecovery = resolve; });
    return { status: 200, body: recoveredLedger };
  };
  const recovery = createEscrowRecovery({ execute, retryDelaysMs: [60_000] });
  const base = await serve({ execute, readStats: async () => { calls += 1; return recoveredLedger; },
    readPrice: async () => 1_000_000,
    ready: () => recovery.whenReady() });

  // Accepting traffic before recovery has started must fail closed.
  for (const route of ["stats", "genesis-receipt", "toll"]) {
    const early = await fetch(`${base}/${route}`);
    assert.equal(early.status, 503, route);
    assert.equal(early.headers.get("retry-after"), "5");
    assert.equal(early.headers.get("cache-control"), "no-store");
    assert.deepEqual(await early.json(), { error: "Durable escrow ledger is recovering" });
  }
  assert.equal(calls, 0);

  void recovery.start();
  let answered = false;
  const waiting = fetch(`${base}/stats`).then((response) => { answered = true; return response; });
  await untilTrue(() => finishRecovery !== undefined, "the recovery attempt");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(answered, false, "stats must wait for the recovery attempt");
  assert.equal(calls, 1, "only the recovery attempt may touch the ledger");
  finishRecovery!({ status: 200, body: recoveredLedger });
  const response = await waiting;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), recoveredLedger);
  assert.equal(calls, 2);
  const quote = await fetch(`${base}/toll`);
  assert.equal(quote.status, 200);
  recovery.stop();
});

test("failed startup recovery keeps escrow routes at 503 until a background retry succeeds", async () => {
  let healthy = false;
  let recoveryCalls = 0;
  let routeCalls = 0;
  // Separate executors: background retries run on their own schedule, so only
  // the route's executor shows whether a gated request reached the ledger.
  const recovery = createEscrowRecovery({
    execute: async () => {
      recoveryCalls += 1;
      if (!healthy) throw new Error("database unavailable");
      return { status: 200, body: recoveredLedger };
    },
    retryDelaysMs: [25],
  });
  const execute: EscrowExecutor = async () => {
    routeCalls += 1;
    return { status: 200, body: recoveredLedger };
  };
  const base = await serve({ execute, readStats: async () => { routeCalls += 1; return recoveredLedger; },
    ready: () => recovery.whenReady() });
  assert.equal(await recovery.start(), false);
  assert.equal(recovery.status, "retrying");
  const unavailable = await fetch(`${base}/stats`);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "5");
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.equal(Object.hasOwn(await unavailable.json() as Record<string, unknown>, "verified_toll_sats"), false);
  assert.equal(routeCalls, 0, "a gated request must not reach the ledger while recovery is failing");
  healthy = true;
  await untilTrue(() => recovery.status === "ready", "the recovery retry");
  assert.ok(recoveryCalls >= 2, "recovery succeeded through a background retry");
  const recovered = await fetch(`${base}/stats`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), recoveredLedger);
  assert.equal(routeCalls, 1);
  recovery.stop();
});

test("public toll quote falls back to exactly 21 when market provider fails", async () => {
  const base = await serve({ readPrice: async () => { throw new Error("offline"); } });
  const response = await fetch(`${base}/toll`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as Record<string, unknown>).toll_fee_sats, 21);
});

test("create envelope accepts dynamically evaluated tolls and rejects zero", async () => {
  for (const fee of [1, 2, 13, 40, 0]) {
    const base = await serve({ execute: async () => ({ status: 201, body: {
      escrow_id: id, payment_hash: "f".repeat(64), status: "LOCKED",
      amount_sats: input.amount_sats, toll_fee_sats: fee,
    } }) });
    const response = await fetch(`${base}/create`, post(input));
    assert.equal(response.status, fee === 0 ? 503 : 201);
    if (fee > 0) assert.equal((await response.json() as Record<string, unknown>).toll_fee_sats, fee);
  }
});

test("returns 400 for missing/unknown fields without reaching payment or Python", async () => {
  const base = await serve({ execute: async () => { throw new Error("Must not execute"); } });
  for (const body of [{}, { ...input, extra: true }, { ...input, amount_sats: 0 },
    { ...input, buyer_pubkey: "bad" }]) {
    assert.equal((await fetch(`${base}/create`, post(body))).status, 400);
  }
});

test("blocks unpaid requests and invalid optional admin overrides; keeps standard CORS", async () => {
  let calls = 0;
  const base = await serve({ execute: async () => { calls++; throw new Error(); } });
  const unpaid = await fetch(`${base}/create`, post(input, { authorization: "" }));
  assert.equal(unpaid.status, 402);
  assert.match(unpaid.headers.get("www-authenticate")!, /^L402 token=".*", invoice=".*"$/);
  assert.equal(unpaid.headers.get("access-control-allow-origin"), "*");
  assert.equal((await fetch(`${base}/create`,
    post(input, { "X-Escrow-Operator-Token": "wrong" }))).status, 403);
  assert.equal(calls, 0);
  const preflight = await fetch(`${base}/settle`, { method: "OPTIONS",
    headers: { "access-control-request-headers": "Authorization,X-Escrow-Operator-Token" } });
  assert.equal(preflight.status, 200);
  assert.match(preflight.headers.get("access-control-allow-headers")!, /Authorization/);
});

test("uses the existing real L402 middleware for well-formed challenge headers", async () => {
  const settlement: SettlementRouter = {
    isConfigured: () => true, activeProvider: () => "test", circuitState: () => "closed",
    createInvoice: async () => ({ invoice: "ln-test", paymentHash: "a".repeat(64),
      provider: "test", asset: "btc-lightning" }),
    verifyPayment: async () => { throw new Error("No payment should be verified"); },
  };
  const base = await serve({ paymentGate: undefined, settlementRouter: settlement,
    sessionSecret: "test-session" });
  const response = await fetch(`${base}/create`, post(input, { authorization: "" }));
  assert.equal(response.status, 402);
  assert.match(response.headers.get("www-authenticate")!, /^L402 token="[^"]+", invoice="ln-test"$/);
});

test("returns exact create and settle envelopes and never exposes a secret in receipt", async () => {
  const execute: EscrowExecutor = async (operation, body, height) => {
    if (operation === "lookup") return { status: 200, body: { status: "LOCKED", toll_fee_sats: 21 } };
    if (operation === "create") return { status: 201, body: {
      escrow_id: id, payment_hash: "f".repeat(64), status: "LOCKED",
      amount_sats: body.amount_sats, toll_fee_sats: 21 } };
    if (operation === "settle") {
      assert.equal(height, 900000);
      return { status: 200, body: { status: "SETTLED", preimage: "a".repeat(64),
        merkle_root: receipt.merkle_root, audit_path: [], article_12_receipt: receipt,
        ots_calendar_standard: OTS_CALENDAR_STANDARD, attestation_directive: ATTESTATION_DIRECTIVE } };
    }
      return { status: 200, body: {
      "@context": { "@vocab": "https://schema.org/" }, "@type": "DigitalDocument",
      identifier: id, dateCreated: receipt.timestamp, proof: receipt,
      verification: { merkle_inclusion: true, bitcoin_anchor_verified: false,
        strata_block_height: 900000, task_hash: input.task_hash,
        trace_hash: "b".repeat(64), result_hash: "c".repeat(64) }, description: "Local proof",
      preimage: "must-be-stripped",
    } };
  };
  const base = await serve({ execute, readHeight: async () => 900000 });
  const created = await fetch(`${base}/create`, post(input));
  assert.equal(created.status, 201);
  assert.equal((await created.json() as Record<string, unknown>).toll_fee_sats, 21);
  const settlementBody = {
    escrow_id: id, execution_trace: "trace", result_payload: "result",
  };
  const challenge = await fetch(`${base}/settle`, post(settlementBody));
  assert.equal(challenge.status, 402);
  const toll = await challenge.json() as { macaroon: string; amount_sats: number };
  assert.equal(toll.amount_sats, 21);
  const settled = await fetch(`${base}/settle`, post(settlementBody, {
    authorization: `L402 ${toll.macaroon}:${tollPreimage}`,
  }));
  assert.equal(settled.status, 200);
  assert.equal((await settled.json() as Record<string, unknown>).status, "SETTLED");
  const read = await fetch(`${base}/receipt/${id}`, { headers: post(null).headers });
  assert.equal(read.status, 200);
  assert.match(read.headers.get("content-type")!, /application\/ld\+json/);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal(Object.hasOwn(await read.json() as object, "preimage"), false);
});

test("settlement and receipt responses preserve leaf evidence and add a pinned-issuer signature", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const leaf = Buffer.from("01".repeat(96), "hex");
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from([0]), leaf])).digest("hex");
  const material = { ...receipt, leaf_preimage: leaf.toString("hex"),
    merkle_root: digest, execution_leaf_hash: digest };
  const base = await serve({ signingKey: privateKey, readHeight: async () => 900000,
    execute: async (operation) => {
      if (operation === "lookup") return { status: 200, body: { status: "LOCKED", toll_fee_sats: 21 } };
      if (operation === "settle") return { status: 200, body: {
        status: "SETTLED", preimage: "a".repeat(64), merkle_root: digest,
        audit_path: [], article_12_receipt: material,
        ots_calendar_standard: OTS_CALENDAR_STANDARD, attestation_directive: ATTESTATION_DIRECTIVE,
      } };
      return { status: 200, body: {
        "@context": { "@vocab": "https://schema.org/" }, "@type": "DigitalDocument",
        identifier: id, dateCreated: material.timestamp, proof: material,
        verification: { merkle_inclusion: true, bitcoin_anchor_verified: false,
          strata_block_height: 900000, task_hash: input.task_hash,
          trace_hash: "b".repeat(64), result_hash: "c".repeat(64) }, description: "Local commitment",
      } };
    } });
  const submission = { escrow_id: id, execution_trace: "trace", result_payload: "result" };
  const challenge = await fetch(`${base}/settle`, post(submission));
  assert.equal(challenge.status, 402);
  const offer = await challenge.json() as { macaroon: string };
  const settled = await fetch(`${base}/settle`, post(submission,
    { authorization: `L402 ${offer.macaroon}:${tollPreimage}` }));
  assert.equal(settled.status, 200);
  const output = await settled.json() as { article_12_receipt: Record<string, unknown> };
  const validateSignature = (signed: Record<string, unknown>) => {
    const { issuer_attestation, ...payload } = signed;
    const { issuer_key_id, issued_at, ...evidence } = payload;
    assert.deepEqual(evidence, material);
    assert.equal(issuer_key_id, issuerKeyId(privateKey));
    assert.equal(new Date(String(issued_at)).toISOString(), issued_at);
    const attestation = issuer_attestation as { signature: string };
    assert.ok(verify(null, Buffer.from("bitcoin-stratigraphy/article12/v1\n" + canonical(payload)),
      publicKey, Buffer.from(attestation.signature, "base64")));
  };
  validateSignature(output.article_12_receipt);
  const read = await fetch(`${base}/receipt/${id}`, { headers: post(null).headers });
  assert.equal(read.status, 200);
  const document = await read.json() as { proof: Record<string, unknown> };
  validateSignature(document.proof);
});

test("returns 404 for absent contracts, 422 for invalid states, and 503 for provider failure", async () => {
  for (const [lookup, expected] of [
    [{ status: 404, body: { error: "Escrow not found" } }, 404],
    [{ status: 200, body: { status: "SETTLED" } }, 422],
    [{ status: 200, body: { status: "LOCKED", toll_fee_sats: 21 } }, 503],
  ] as const) {
    const base = await serve({
      execute: async () => lookup, readHeight: async () => { throw new Error("private error"); },
    });
    const response = await fetch(`${base}/settle`, post({
      escrow_id: id, execution_trace: "trace", result_payload: "result",
    }));
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private error/);
  }
});

test("exact 24-sat NWC toll withholds execution until settled and binds the entire flight record", async () => {
  let settled = false;
  let walletAmount = 24_000;
  let walletDescription = "Autonomous Escrow execution settlement toll";
  let walletAvailable = true;
  let executionCalls = 0;
  let closes = 0;
  const requestedAmounts: number[] = [];
  const provider = createNwcSettlementProvider({
    name: "coinos", uri: () => "nostr+walletconnect://test-only",
    clientFactory: () => ({
      makeInvoice: async (request) => {
        requestedAmounts.push(request.amount);
        return { invoice: "ln-test-toll", payment_hash: tollHash } as never;
      },
      lookupInvoice: async () => {
        if (!walletAvailable) throw new Error("network unavailable");
        return {
          type: "incoming", state: settled ? "settled" : "pending",
          amount: walletAmount, description: walletDescription,
          payment_hash: tollHash, preimage: tollPreimage, settled_at: 1700000000,
        } as never;
      },
      close: () => { closes++; },
    }),
  });
  const settlementRouter = createSettlementRouter({
    primary: provider,
    fallback: { name: "disabled", isConfigured: () => false,
      createInvoice: async () => { throw new Error("disabled"); },
      verifyPayment: async () => "invalid" },
  });
  const base = await serve({
    settlementRouter, readHeight: async () => 900000,
    execute: async (operation, _body, _height, _signal, payment) => {
      if (operation === "lookup") return { status: 200, body: { status: "LOCKED", toll_fee_sats: 24 } };
      assert.equal(operation, "settle");
      executionCalls++;
      assert.equal(payment?.payment_hash, tollHash);
      assert.equal(payment?.amount_sats, 24);
      assert.equal(payment?.provider, "coinos");
      assert.equal(Object.hasOwn(payment!, "preimage"), false);
      return { status: 200, body: { status: "SETTLED", preimage: "a".repeat(64),
        merkle_root: receipt.merkle_root, audit_path: [],
        ots_calendar_standard: OTS_CALENDAR_STANDARD, attestation_directive: ATTESTATION_DIRECTIVE,
        article_12_receipt: { ...receipt, lightning_settlement: payment } } };
    },
  });
  const body = { escrow_id: id, execution_trace: "flight record", result_payload: '{"result":1}' };
  const initial = await fetch(`${base}/settle`, post(body, { authorization: "" }));
  assert.equal(initial.status, 402);
  const challenge = await initial.json() as { macaroon: string; amount_sats: number; preimage?: string };
  assert.equal(challenge.amount_sats, 24);
  assert.equal(challenge.preimage, undefined);
  assert.equal(executionCalls, 0);
  assert.deepEqual(requestedAmounts, [24_000]);
  const headers = { authorization: `L402 ${challenge.macaroon}:${tollPreimage}` };
  const pending = await fetch(`${base}/settle`, post(body, headers));
  assert.equal(pending.status, 402);
  assert.equal(executionCalls, 0);
  settled = true;
  walletAmount = 23_000;
  assert.equal((await fetch(`${base}/settle`, post(body, headers))).status, 402);
  walletAmount = 24_000;
  walletDescription = "Different product";
  assert.equal((await fetch(`${base}/settle`, post(body, headers))).status, 402);
  walletDescription = "Autonomous Escrow execution settlement toll";
  for (const modified of [
    { ...body, escrow_id: "22222222-2222-4222-8222-222222222222" },
    { ...body, execution_trace: "different flight record" },
    { ...body, result_payload: '{"result":2}' },
  ]) assert.equal((await fetch(`${base}/settle`, post(modified, headers))).status, 402);
  assert.equal(executionCalls, 0);
  assert.equal((await fetch(`${base}/settle`, post(body, {
    authorization: `L402 ${challenge.macaroon}:${"8".repeat(64)}`,
  }))).status, 402);
  const completed = await fetch(`${base}/settle`, post(body, headers));
  assert.equal(completed.status, 200);
  const output = await completed.json() as { preimage: string; article_12_receipt: { lightning_settlement: { amount_sats: number } } };
  assert.equal(output.preimage, "a".repeat(64));
  assert.equal(output.article_12_receipt.lightning_settlement.amount_sats, 24);
  assert.equal(executionCalls, 1);
  assert.equal((await fetch(`${base}/settle`, post(body, headers))).status, 429);
  assert.equal(executionCalls, 1);
  assert.ok(closes > 0);
  // A separate capability avoids the successful proof cache in the outage check.
  const outageBody = { ...body, execution_trace: "new unavailable flight" };
  const issued = await fetch(`${base}/settle`, post(outageBody, { authorization: "" }));
  const other = await issued.json() as { macaroon: string };
  walletAvailable = false;
  const unavailable = await fetch(`${base}/settle`, post(outageBody, {
    authorization: `L402 ${other.macaroon}:${tollPreimage}`,
  }));
  assert.equal(unavailable.status, 502);
  assert.equal(executionCalls, 1);
});

for (const proof of [tollPreimage, "NWC_LOOKUP", "", "11111111-1111-4111-8111-111111111111"])
test(`public create/settle uses ${proof.length === 64 ? "preimage" : proof || "empty proof"} and rejects cross-contract redemption`, async () => {
  let executions = 0;
  const base = await serve({
    operatorSecret: "", paymentGate: undefined, readHeight: async () => 900000,
    execute: async (operation, body, _height, _signal, payment) => {
      assert.equal(Object.hasOwn(body, "settlement_capability"), false);
      if (operation === "create") return { status: 201, body: {
        escrow_id: id, payment_hash: "f".repeat(64), status: "LOCKED",
        amount_sats: body.amount_sats, toll_fee_sats: 24,
      } };
      if (operation === "lookup") return { status: 200, body: { status: "LOCKED", toll_fee_sats: 24 } };
      assert.equal(payment?.amount_sats, 24);
      executions++;
      return { status: 200, body: {
        status: "SETTLED", preimage: "a".repeat(64), merkle_root: receipt.merkle_root,
        audit_path: [], ots_calendar_standard: OTS_CALENDAR_STANDARD,
        attestation_directive: ATTESTATION_DIRECTIVE,
        article_12_receipt: { ...receipt, lightning_settlement: payment },
      } };
    },
  });
  const publicPost = (body: unknown, authorization = "") => ({
    method: "POST", headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });
  const createdChallenge = await fetch(`${base}/create`, publicPost(input));
  assert.equal(createdChallenge.status, 402);
  const first = await createdChallenge.json() as { macaroon: string; staged_preview: {
    status: string; quoted_toll_sats: number; merkle_standard: string; expected_output_schema: object;
  } };
  assert.equal(first.staged_preview.status, "ENDPOINT_READY_AWAITING_L402_SETTLEMENT");
  assert.equal(first.staged_preview.quoted_toll_sats, 21);
  assert.equal(first.staged_preview.merkle_standard, "RFC 6962 SHA-256");
  assert.ok(first.staged_preview.expected_output_schema);
  const created = await fetch(`${base}/create`, publicPost(input, `L402 ${first.macaroon}:${proof}`));
  assert.equal(created.status, 201);
  const contract = await created.json() as { settlement_capability: string };
  assert.match(contract.settlement_capability, /^[0-9a-f]{64}$/);
  const submission = { escrow_id: id, execution_trace: "trace", result_payload: "result" };
  assert.equal((await fetch(`${base}/settle`, publicPost(submission))).status, 403);
  assert.equal((await fetch(`${base}/settle`, publicPost({
    ...submission, settlement_capability: "0".repeat(64),
  }))).status, 403);
  assert.equal((await fetch(`${base}/settle`, publicPost({
    ...submission, escrow_id: "22222222-2222-4222-8222-222222222222",
    settlement_capability: contract.settlement_capability,
  }))).status, 403);
  const authorized = { ...submission, settlement_capability: contract.settlement_capability };
  const challenge = await fetch(`${base}/settle`, publicPost(authorized));
  assert.equal(challenge.status, 402);
  assert.equal(executions, 0);
  const quote = await challenge.json() as { macaroon: string; amount_sats: number;
    staged_preview: { quoted_toll_sats: number; expected_output_schema: {
      $ref: string; $defs: { EscrowSettlement: { properties: { article_12_receipt: unknown } }; EscrowReceipt: unknown };
    } } };
  assert.equal(quote.amount_sats, 24);
  assert.equal(quote.staged_preview.quoted_toll_sats, 24);
  assert.equal(quote.staged_preview.expected_output_schema.$ref, "#/$defs/EscrowSettlement");
  assert.ok(quote.staged_preview.expected_output_schema.$defs.EscrowSettlement.properties.article_12_receipt);
  assert.ok(quote.staged_preview.expected_output_schema.$defs.EscrowReceipt);
  const settled = await fetch(`${base}/settle`, publicPost(authorized, `L402 ${quote.macaroon}:${proof}`));
  assert.equal(settled.status, 200);
  const output = await settled.json() as Record<string, unknown>;
  assert.equal(output.attestation_directive, ATTESTATION_DIRECTIVE);
  assert.equal(output.ots_calendar_standard, OTS_CALENDAR_STANDARD);
  assert.equal(Object.hasOwn(output, "settlement_capability"), false);
  assert.equal(executions, 1);
  assert.equal((await fetch(`${base}/settle`, publicPost(authorized, `L402 ${quote.macaroon}:${proof}`))).status, 429);
  assert.equal(executions, 1);
});

/** Settles every LOCKED lookup and echoes the forwarded attribution into the receipt. */
function attributingExecutor(
  executions: Array<{ body: Record<string, unknown>; attribution?: EscrowAgentAttribution }>,
): EscrowExecutor {
  return async (operation, body, _height, _signal, payment, attribution) => {
    if (operation === "lookup") {
      assert.equal(attribution, undefined);
      return { status: 200, body: { status: "LOCKED", toll_fee_sats: 24 } };
    }
    assert.equal(operation, "settle");
    executions.push({ body, ...(attribution === undefined ? {} : { attribution }) });
    return { status: 200, body: {
      status: "SETTLED", preimage: "a".repeat(64), merkle_root: receipt.merkle_root,
      audit_path: [], ots_calendar_standard: OTS_CALENDAR_STANDARD,
      attestation_directive: ATTESTATION_DIRECTIVE,
      article_12_receipt: {
        ...receipt, lightning_settlement: payment,
        ...(attribution === undefined ? {} : { agent_id: attribution.agentId }),
        ...(attribution?.authentication === undefined ? {}
          : { agent_authentication: attribution.authentication }),
      },
    } };
  };
}

test("settle binds a declared agent_id into the toll macaroon and forwards only the verified caveat", async () => {
  const executions: Array<{ body: Record<string, unknown>; attribution?: EscrowAgentAttribution }> = [];
  const base = await serve({
    readHeight: async () => 900000,
    execute: attributingExecutor(executions),
  });
  const challengeFor = async (body: Record<string, unknown>, headers = {}) => {
    const response = await fetch(`${base}/settle`, post(body, { authorization: "", ...headers }));
    assert.equal(response.status, 402);
    return await response.json() as { macaroon: string; agent_id?: string };
  };
  const caveatsOf = (macaroon: string) =>
    (JSON.parse(Buffer.from(macaroon, "base64url").toString("utf8")) as { caveats: string[] }).caveats;
  const submission = { escrow_id: id, execution_trace: "agent trace", result_payload: "agent result" };

  // X-Agent-Id declaration: bound into the macaroon and required on redemption.
  const quote = await challengeFor(submission, { "X-Agent-Id": "planner-7" });
  assert.equal(quote.agent_id, "planner-7");
  assert.equal(caveatsOf(quote.macaroon).filter((caveat) => caveat === "agent_id = planner-7").length, 1);
  const paid = { authorization: `L402 ${quote.macaroon}:${tollPreimage}` };
  for (const [attempt, headers] of [
    [submission, paid],
    [submission, { ...paid, "X-Agent-Id": "planner-8" }],
    [{ ...submission, agent_id: "planner-8" }, paid],
  ] as const) {
    const refused = await fetch(`${base}/settle`, post(attempt, headers));
    assert.equal(refused.status, 403);
  }
  assert.equal(executions.length, 0);
  const settled = await fetch(`${base}/settle`, post(submission, { ...paid, "X-Agent-Id": "planner-7" }));
  assert.equal(settled.status, 200);
  const output = await settled.json() as { article_12_receipt: { agent_id?: string } };
  assert.equal(output.article_12_receipt.agent_id, "planner-7");
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0]!.attribution, { agentId: "planner-7" });
  assert.deepEqual(Object.keys(executions[0]!.body).sort(), ["escrow_id", "execution_trace", "result_payload"]);

  // Body declaration: the field is stripped; only the caveat reaches the engine.
  const bodySubmission = { ...submission, execution_trace: "second trace", agent_id: "auditor.eu-12" };
  const bodyQuote = await challengeFor(bodySubmission);
  assert.ok(caveatsOf(bodyQuote.macaroon).includes("agent_id = auditor.eu-12"));
  const bodySettled = await fetch(`${base}/settle`, post(bodySubmission, {
    authorization: `L402 ${bodyQuote.macaroon}:${tollPreimage}`,
  }));
  assert.equal(bodySettled.status, 200);
  assert.deepEqual(executions[1]!.attribution, { agentId: "auditor.eu-12" });
  assert.equal(Object.hasOwn(executions[1]!.body, "agent_id"), false);

  // Undeclared settlements stay unattributed, and late declarations are refused.
  const plain = { ...submission, execution_trace: "third trace" };
  const plainQuote = await challengeFor(plain);
  assert.equal(Object.hasOwn(plainQuote, "agent_id"), false);
  const plainPaid = { authorization: `L402 ${plainQuote.macaroon}:${tollPreimage}` };
  assert.equal((await fetch(`${base}/settle`, post(plain, { ...plainPaid, "X-Agent-Id": "planner-7" }))).status, 403);
  assert.equal((await fetch(`${base}/settle`, post(plain, plainPaid))).status, 200);
  assert.equal(executions[2]!.attribution, undefined);

  // Malformed or conflicting declarations never reach a challenge or the engine.
  for (const [attempt, headers] of [
    [submission, { "X-Agent-Id": "planner 7" }],
    [{ ...submission, agent_id: "planner 7" }, {}],
    [{ ...submission, agent_id: "planner-7" }, { "X-Agent-Id": "planner-8" }],
  ] as const) {
    const rejected = await fetch(`${base}/settle`, post(attempt, { authorization: "", ...headers }));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.has("www-authenticate"), false);
  }
  assert.equal(executions.length, 3);
});

test("settle binds a NIP-98 signer as the authenticated agent_id and refuses forged signatures", async () => {
  const executions: Array<{ body: Record<string, unknown>; attribution?: EscrowAgentAttribution }> = [];
  const base = await serve({ readHeight: async () => 900000, execute: attributingExecutor(executions) });
  const url = `${base}/settle`;
  const agentKey = generateSecretKey();
  const agentPubkey = getPublicKey(agentKey);
  const submission = { escrow_id: id, execution_trace: "signed trace", result_payload: "signed result" };
  // post() sends JSON.stringify(body), so the payload tag hashes those exact bytes.
  const sign = (body: unknown) => {
    const event = finalizeEvent({
      kind: 27_235, created_at: Math.floor(Date.now() / 1_000), content: "",
      tags: [["u", url], ["method", "POST"],
        ["payload", createHash("sha256").update(JSON.stringify(body)).digest("hex")]],
    }, agentKey);
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  };

  // An event claiming another pubkey fails Schnorr verification: 401, no invoice.
  const genuine = sign(submission);
  const event = JSON.parse(Buffer.from(genuine.slice("Nostr ".length), "base64").toString("utf8"));
  const forged = `Nostr ${Buffer.from(JSON.stringify({
    ...event, pubkey: getPublicKey(generateSecretKey()),
  })).toString("base64")}`;
  const refused = await fetch(url, post(submission, { authorization: forged }));
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: "Invalid NIP-98 authorization" });
  assert.equal(refused.headers.has("www-authenticate"), false);

  const challenge = await fetch(url, post(submission, { authorization: genuine }));
  assert.equal(challenge.status, 402);
  const quote = await challenge.json() as { macaroon: string; agent_id?: string; agent_authentication?: string };
  assert.equal(quote.agent_id, agentPubkey);
  assert.equal(quote.agent_authentication, "nip98");
  const paid = { authorization: `L402 ${quote.macaroon}:${tollPreimage}` };
  // Declaring the pubkey without a fresh signature does not redeem it.
  assert.equal((await fetch(url, post(submission, { ...paid, "X-Agent-Id": agentPubkey }))).status, 401);
  assert.equal(executions.length, 0);
  const settled = await fetch(url, post(submission, { ...paid, "X-Nostr-Authorization": sign(submission) }));
  assert.equal(settled.status, 200);
  const output = await settled.json() as {
    article_12_receipt: { agent_id?: string; agent_authentication?: string };
  };
  assert.equal(output.article_12_receipt.agent_id, agentPubkey);
  assert.equal(output.article_12_receipt.agent_authentication, "nip98");
  assert.deepEqual(executions.map((execution) => execution.attribution),
    [{ agentId: agentPubkey, authentication: "nip98" }]);
});
