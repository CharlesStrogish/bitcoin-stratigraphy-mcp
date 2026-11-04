import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiduciaryClient, CircuitBreakerError, TruthReceipt } from "../dist/sdk/agent-yield/src/index.js";
import { SpendCircuit } from "../dist/sdk/agent-yield/src/armor.js";
import { invoice, json } from "./fixtures.mjs";

async function setup(t, max_spend_sats, uncertain = false, feeReserveSats = 0) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "sdk-armor-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let http = 0, payments = 0;
  const invoices = new Map();
  const fetch = async (input, init) => {
    http++;
    const request = new Request(input, init);
    const body = await request.json();
    if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id,
      result: { tools: [{ name: "proof.verify", inputSchema: { type: "object" } }] } });
    if (!request.headers.has("authorization")) {
      const preimage = createHash("sha256").update(String(body.id)).digest("hex");
      const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
      const bolt11 = invoice(100000n, hash);
      invoices.set(bolt11, preimage);
      const quote = { invoice: bolt11, macaroon: "synthetic", payment_hash: hash, amount_sats: 100 };
      return json({ jsonrpc: "2.0", id: body.id, error: { code: 402, data: quote } }, 402,
        { "WWW-Authenticate": `L402 macaroon="synthetic", invoice="${bolt11}"` });
    }
    return json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { value: body.params.arguments.n } } });
  };
  const client = new FiduciaryClient({
    max_spend_sats, stateDirectory, maxPaymentSats: 500, maxTotalSats: 10000,
    feeReserveSats, fetch,
    wallet: { async payInvoice(text) {
      payments++;
      if (uncertain) throw new Error("unknown outcome");
      return { preimage: invoices.get(text), fees_paid: 0 };
    } },
  });
  return { client, counts: () => ({ http, payments }) };
}

test("paid tool returns exact proof-bound TruthReceipt without claiming data anchoring", async t => {
  const s = await setup(t, 5000);
  const receipt = await s.client.callTool("proof.verify", { n: 1 });
  assert.ok(receipt instanceof TruthReceipt);
  assert.deepEqual(receipt.payload, { value: 1 });
  assert.equal(receipt.thermodynamic_cost, "100");
  assert.equal(createHash("sha256").update(Buffer.from(receipt.cryptographic_proof, "hex")).digest("hex"), receipt.payment_hash);
  assert.equal(receipt.evidence_scope, "payment_only");
  assert.equal(receipt.timestamp_kind, "client_observed_settlement");
  assert.match(receipt.timestamp, /Z$/);
  assert.equal(receipt.payload_sha256, createHash("sha256").update(JSON.stringify(receipt.payload)).digest("hex"));
  await s.client.drain();
});

test("loop stops at the exact session limit before any further outbound request", async t => {
  const s = await setup(t, 200);
  await s.client.callTool("proof.verify", { n: 1 });
  await s.client.callTool("proof.verify", { n: 2 });
  const before = s.counts();
  for (let n = 3; n < 20; n++) {
    await assert.rejects(s.client.callTool("proof.verify", { n }), error =>
      error instanceof CircuitBreakerError &&
      error.message === "Maximum authorized thermodynamic spend reached.");
  }
  assert.deepEqual(s.counts(), before);
  assert.equal(before.payments, 2);
  await s.client.drain();
});

test("oversized quote latches breaker before wallet or paid HTTP retry", async t => {
  const s = await setup(t, 50);
  await assert.rejects(s.client.callTool("proof.verify"), CircuitBreakerError);
  assert.deepEqual(s.counts(), { http: 2, payments: 0 }); // Public discovery + unpaid quote only.
  await assert.rejects(s.client.callTool("proof.verify"), CircuitBreakerError);
  assert.deepEqual(s.counts(), { http: 2, payments: 0 });
});

test("concurrent new invoices cannot race past the remaining session capacity", async t => {
  const s = await setup(t, 100);
  const result = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => s.client.callTool("proof.verify", { n })));
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(s.counts().payments, 1);
  await s.client.drain();
});

test("unknown payment outcomes keep session capacity reserved", async t => {
  const s = await setup(t, 100, true);
  await assert.rejects(s.client.callTool("proof.verify"), /PAYMENT_UNCERTAIN/);
  const before = s.counts();
  await assert.rejects(s.client.callTool("proof.verify"), CircuitBreakerError);
  assert.deepEqual(s.counts(), before);
});

test("fee headroom is reserved before payment and unused allowance is reclaimed", async t => {
  const blocked = await setup(t, 100, false, 10);
  await assert.rejects(blocked.client.callTool("proof.verify"), CircuitBreakerError);
  assert.equal(blocked.counts().payments, 0);
  const s = await setup(t, 110, false, 10);
  const receipt = await s.client.callTool("proof.verify");
  assert.equal(receipt.thermodynamic_cost, "100");
  // Actual zero fees release 10 sats of the admission allowance.
  const circuit = new SpendCircuit(110);
  circuit.reserve("p", 110000n);
  circuit.settle("p", 100000n);
  assert.equal(circuit.remainingMsats, 10000n);
  await s.client.drain();
});

test("default, zero, fractional precision and invalid session policies", () => {
  assert.equal(new SpendCircuit().remainingMsats, 5000000n);
  assert.throws(() => new SpendCircuit(0).assertCapacity(), CircuitBreakerError);
  for (const bad of [-1, 1.5, NaN, Infinity, "5000", true]) {
    assert.throws(() => new SpendCircuit(bad), /INVALID_MAX_SPEND_SATS/);
  }
  const receipt = new TruthReceipt({}, { amountMsats: "21001", preimage: "p", paymentHash: "h", settledAt: null });
  assert.equal(receipt.thermodynamic_cost, "21.001");
  assert.equal(receipt.timestamp, null);
  const free = new TruthReceipt({ free: true });
  assert.equal(free.cryptographic_proof, null);
  assert.equal(free.thermodynamic_cost, "0");
});
