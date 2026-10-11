// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { registerEscrowRoutes, assertEscrowMcpRegistryIntegrity } from "./escrow";
import { registerPublicCors } from "../middleware/publicCors";
import { openApiDocument } from "../openapi";
import type { EscrowExecutor } from "../services/escrowBridge";
import type { SettlementRouter } from "../services/settlement";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const id = "11111111-1111-4111-8111-111111111111";
const input = { buyer_pubkey: "a".repeat(64), worker_pubkey: "b".repeat(64),
  task_hash: "c".repeat(64), amount_sats: 100 };
const receipt = {
  escrow_id: id, leaf_index: 0, audit_path: [], merkle_root: "d".repeat(64),
  timestamp: "2026-10-09T12:00:00+00:00", tree_size: 1,
  execution_leaf_hash: "e".repeat(64), settled_at_strata_block: 900000,
  receipt_type: "article_12_execution_commitment",
};
const paymentGate: RequestHandler = (req, res, next) => {
  if (req.get("authorization") !== "L402 test:proof") {
    res.set("WWW-Authenticate", 'L402 token="test", invoice="ln-test"');
    res.status(402).json({ error: "Payment required" });
  } else next();
};

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()))));
});

async function serve(options: Parameters<typeof registerEscrowRoutes>[1] = {}) {
  const app = express();
  registerPublicCors(app);
  app.use(express.json());
  registerEscrowRoutes(app, { operatorSecret: "test-operator", paymentGate, ...options });
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

test("preserves exactly 15 MCP tool schemas and documents all three REST routes", () => {
  assertEscrowMcpRegistryIntegrity();
  assert.equal(Object.keys(openApiDocument["x-mcp-tools"] as object).length, 15);
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

test("blocks unpaid requests and paid non-operators; keeps standard CORS", async () => {
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
    if (operation === "lookup") return { status: 200, body: { status: "LOCKED" } };
    if (operation === "create") return { status: 201, body: {
      escrow_id: id, payment_hash: "f".repeat(64), status: "LOCKED",
      amount_sats: body.amount_sats, toll_fee_sats: 21 } };
    if (operation === "settle") {
      assert.equal(height, 900000);
      return { status: 200, body: { status: "SETTLED", preimage: "a".repeat(64),
        merkle_root: receipt.merkle_root, audit_path: [], article_12_receipt: receipt } };
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
  const settled = await fetch(`${base}/settle`, post({
    escrow_id: id, execution_trace: "trace", result_payload: "result",
  }));
  assert.equal(settled.status, 200);
  assert.equal((await settled.json() as Record<string, unknown>).status, "SETTLED");
  const read = await fetch(`${base}/receipt/${id}`, { headers: post(null).headers });
  assert.equal(read.status, 200);
  assert.match(read.headers.get("content-type")!, /application\/ld\+json/);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal(Object.hasOwn(await read.json() as object, "preimage"), false);
});

test("returns 404 for absent contracts, 422 for invalid states, and 503 for provider failure", async () => {
  for (const [lookup, expected] of [
    [{ status: 404, body: { error: "Escrow not found" } }, 404],
    [{ status: 200, body: { status: "SETTLED" } }, 422],
    [{ status: 200, body: { status: "LOCKED" } }, 503],
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
