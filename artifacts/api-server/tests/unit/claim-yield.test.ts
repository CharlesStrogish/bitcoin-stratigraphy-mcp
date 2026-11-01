import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { bech32 } from "@scure/base";
import express from "express";
import { pool } from "@workspace/db";
import { createPrivateYieldEarnings } from "../../src/lib/private-yield-earnings";
import { registerClaimYieldRoute } from "../../src/routes/claim-yield";
import { createSubscriptionMacaroon, attenuateSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import { createPublicYieldLedger } from "../../src/lib/public-yield-ledger";
import { parseYieldWithdrawalInvoice } from "../../src/lib/yield-withdrawal-invoice";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";

const secret = "private-yield-regression-secret";
const clock = Date.parse("2026-11-01T12:00:00Z");
const hash = () => randomBytes(32).toString("hex");
function invoice(msats: bigint, paymentHash = hash(), time = clock): string {
  let timestamp = Math.floor(time / 1000);
  const words = Array(7).fill(0);
  for (let i = 6; i >= 0; i--) { words[i] = timestamp % 32; timestamp = Math.floor(timestamp / 32); }
  words.push(1, 1, 20, ...bech32.toWords(Buffer.from(paymentHash, "hex")));
  // Description "mock" and a placeholder recoverable signature: no real wallet is called.
  const description = bech32.toWords(Buffer.from("mock"));
  words.push(13, 0, description.length, ...description, ...Array(104).fill(0));
  return bech32.encode(`lnbc${msats * 10n}p`, words, 4096);
}
function receipt(paymentHash: string, sats = 100): string {
  const root = createSubscriptionMacaroon({
    secret, paymentHash, tier: "1-day", validUntil: 1, // Expired access is still a historical paid receipt.
    amountMsats: sats * 1000, paymentAsset: "btc-lightning", paymentProvider: "test-wallet",
  });
  return attenuateSubscriptionMacaroon(root, ["allowed_path=/paid", "max_requests=1"])!;
}

test("BOLT11 BTC, milli, micro, nano and pico units convert to exact millisatoshis", () => {
  const { words } = bech32.decode(invoice(21_000n) as `${string}1${string}`, 4096);
  for (const [prefix, expected] of [
    ["lnbc1", 100_000_000_000n], ["lnbc1m", 100_000_000n],
    ["lnbc1u", 100_000n], ["lnbc1n", 100n], ["lnbc10p", 1n], ["lnbc210n", 21_000n],
  ] as const) {
    assert.equal(parseYieldWithdrawalInvoice(bech32.encode(prefix, words, 4096), clock).amountMsats, expected);
  }
  assert.throws(() => parseYieldWithdrawalInvoice(bech32.encode("lnbc1p", words, 4096), clock));
});

test("private yield claims are durable, atomic and double-spend safe against real PostgreSQL", async t => {
  const schema = "yield_claim_test_" + randomBytes(8).toString("hex");
  assert.match(schema, /^[a-z0-9_]+$/);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const isolated = { connect: async () => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  } } as typeof pool;
  const fixture = await isolated.connect();
  const logs: Record<string, unknown>[] = [];
  const app = express();
  app.use(apiRootAliases);
  app.use(express.json());
  registerClaimYieldRoute(app, createPrivateYieldEarnings(isolated, () => clock), {
    secret, now: () => clock, logMock: event => { logs.push(event); },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/claim-yield`;
  const send = (macaroons: string[], bolt11_invoice = invoice(BigInt(macaroons.length) * 21_000n)) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macaroons, bolt11_invoice }) });
  const seed = async (sats = 100) => {
    const paymentHash = hash();
    await fixture.query("INSERT INTO revenue_ledger VALUES ($1,'L402',$2)", [paymentHash, sats]);
    return { hash: paymentHash, macaroon: receipt(paymentHash, sats) };
  };
  try {
    await fixture.query(`
      CREATE TABLE revenue_ledger (payment_hash text PRIMARY KEY, channel text NOT NULL, sats_received bigint NOT NULL);
      CREATE TABLE private_yield_claims (
        id text PRIMARY KEY, invoice_payment_hash text NOT NULL UNIQUE, invoice_digest text NOT NULL,
        total_msats bigint NOT NULL, settlement_mode text NOT NULL DEFAULT 'mock', created_at timestamptz NOT NULL);
      CREATE TABLE private_yield_earnings (
        payment_hash text PRIMARY KEY, provider text NOT NULL, gross_msats bigint NOT NULL,
        earned_msats bigint NOT NULL, balance_msats bigint NOT NULL,
        claim_id text REFERENCES private_yield_claims(id), claimed_at timestamptz);
    `);
    await t.test("successful mock fully deducts balance; replay and descendant claims fail", async () => {
      const item = await seed();
      const result = await send([item.macaroon]);
      assert.equal(result.status, 200);
      const body = await result.json();
      assert.equal(body.status, "SIMULATED_WITHDRAWAL");
      assert.equal(body.payment_sent, false);
      assert.equal(body.claimed_msats, "21000");
      assert.equal(body.remaining_balance_msats, "0");
      assert.equal((await send([item.macaroon])).status, 409);
      const descendant = attenuateSubscriptionMacaroon(item.macaroon, ["max_requests=1"])!;
      assert.equal((await send([descendant])).status, 409);
      const state = await fixture.query("SELECT balance_msats, claim_id FROM private_yield_earnings WHERE payment_hash=$1", [item.hash]);
      assert.equal(state.rows[0].balance_msats, "0");
      assert.equal(state.rows[0].claim_id, body.claim_id);
      // A recreated adapter sees committed state, not a process-local replay cache.
      await assert.rejects(createPrivateYieldEarnings(isolated, () => clock).claim(
        [{ paymentHash: item.hash, provider: "test-wallet", amountMsats: 100_000 }],
        { amountMsats: 21_000n, paymentHash: hash(), expiresAt: clock + 3600_000 }, "mock",
      ), (error: any) => error.status === 409);
      assert.equal(logs.length, 1);
    });
    await t.test("concurrent requests have exactly one winner", async () => {
      const item = await seed();
      const responses = await Promise.all(Array.from({ length: 8 }, () => send([item.macaroon])));
      assert.deepEqual(responses.map(response => response.status).sort(), [200,409,409,409,409,409,409,409]);
    });
    await t.test("mixed batches roll back completely and duplicates cannot multiply earnings", async () => {
      const used = await seed();
      const fresh = await seed();
      assert.equal((await send([used.macaroon])).status, 200);
      assert.equal((await send([fresh.macaroon, used.macaroon])).status, 409);
      const child = attenuateSubscriptionMacaroon(fresh.macaroon, ["max_requests=1"])!;
      assert.equal((await send([fresh.macaroon, child])).status, 400);
      assert.equal((await send([fresh.macaroon])).status, 200);
      const a = await seed(); const b = await seed();
      const batch = await send([a.macaroon,b.macaroon]);
      assert.equal(batch.status, 200);
      assert.equal((await batch.json()).claimed_msats, "42000");
    });
    await t.test("unpaid, tampered and wrong-amount receipts cannot establish earnings", async () => {
      assert.equal((await send([receipt(hash())])).status, 404);
      assert.equal((await send(["forged"])).status, 403);
      const item = await seed();
      assert.equal((await send([receipt(item.hash, 101)])).status, 403);
      assert.equal((await send([item.macaroon], invoice(20_000n))).status, 400);
      assert.equal((await send([item.macaroon], invoice(21_000n, hash(), clock - 7200_000))).status, 400);
      assert.equal((await send([item.macaroon], "lnbc" + "q".repeat(120))).status, 400);
      assert.equal((await send([item.macaroon])).status, 200);
    });
    await t.test("invoice reuse rolls back the second balance and no bearer data enters mock logs", async () => {
      const a = await seed(); const b = await seed();
      const destination = invoice(21_000n);
      assert.equal((await send([a.macaroon], destination)).status, 200);
      assert.equal((await send([b.macaroon], destination)).status, 409);
      assert.equal((await send([b.macaroon])).status, 200);
      assert.doesNotMatch(JSON.stringify(logs), new RegExp(a.macaroon + "|" + destination));
      assert.deepEqual(createPublicYieldLedger().snapshot(), []);
    });
    await t.test("storage failures are explicit rather than mocked successful payments", async () => {
      const broken = express(); broken.use(express.json());
      registerClaimYieldRoute(broken, { claim: async () => { throw new Error("database down"); } },
        { secret, now: () => clock });
      const listener = broken.listen(0, "127.0.0.1");
      await once(listener, "listening");
      try {
        const response = await fetch(`http://127.0.0.1:${(listener.address() as any).port}/api/claim-yield`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ macaroons: [receipt(hash())], bolt11_invoice: invoice(21_000n) }),
        });
        assert.equal(response.status, 503);
      } finally { listener.close(); await once(listener, "close"); }
    });
    await t.test("API-server-relative OpenAPI alias reaches the identical claim endpoint", async () => {
      const item = await seed();
      const response = await fetch(url.replace("/api/claim-yield", "/api/api/claim-yield"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macaroons: [item.macaroon], bolt11_invoice: invoice(21_000n) }),
      });
      assert.equal(response.status, 200);
      assert.equal((await send([item.macaroon])).status, 409);
    });
  } finally {
    server.close(); await once(server, "close");
    fixture.release();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
