import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { bech32 } from "@scure/base";
import { pool } from "@workspace/db";
import { createL402Middleware } from "../../src/middleware/l402";
import { attenuateSubscriptionMacaroon, inspectSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import { createPostgresMacaroonUsageStore } from "../../src/lib/postgres-macaroon-usage-store";
import { createMemoryRevenueLedger, type RevenueLedger } from "../../src/services/ledger";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import { createPrivateYieldEarnings } from "../../src/lib/private-yield-earnings";
import { registerClaimYieldRoute } from "../../src/routes/claim-yield";
import type { MacaroonUsageStore } from "../../src/lib/macaroon-usage-store";
import type { SettlementRouter } from "../../src/services/settlement";

const secret = "high-velocity-regression-secret";
const hash = () => randomBytes(32).toString("hex");

async function harness(options: {
  usageStore?: MacaroonUsageStore; ledger?: RevenueLedger;
  configure?: (app: express.Express, now: () => number) => void;
} = {}) {
  let clock = Date.now();
  let verifications = 0;
  let executions = 0;
  const invoices = new Map<string, { preimage: string; amount: number; description: string }>();
  const revocations = createMemoryMacaroonRevocationStore();
  const router: SettlementRouter = {
    isConfigured: () => true, activeProvider: () => "test-wallet", circuitState: () => "closed",
    async createInvoice(input) {
      const preimage = hash();
      const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
      invoices.set(paymentHash, { preimage, amount: input.amountMsats, description: input.description });
      return { invoice: "lnbc1whale", paymentHash, provider: "test-wallet" };
    },
    async verifyPayment(input) {
      verifications++;
      const invoice = invoices.get(input.paymentHash);
      if (!invoice || input.expectedAmountMsats !== invoice.amount ||
          input.expectedDescription !== invoice.description ||
          input.expectedProvider !== "test-wallet" || input.preimage !== invoice.preimage) return "invalid";
      return { settledAt: Math.floor(clock / 1000), provider: "test-wallet" };
    },
  };
  const app = express();
  app.use(express.json());
  options.configure?.(app, () => clock);
  const common = { amountSats: 250, description: "whale test", scopePath: "/paid",
    settlementRouter: router, sessionSecret: secret, maxChallengesPerMinute: 1000,
    allowBatch: true, now: () => clock, revocationStore: revocations,
    usageStore: options.usageStore, ledger: options.ledger };
  app.get("/paid", createL402Middleware(common), (_req, res) => { executions++; res.json({ paid: true }); });
  app.get("/other", createL402Middleware({ ...common, scopePath: "/other" }), (_req, res) => res.json({ paid: true }));
  app.get("/fixed", createL402Middleware({ ...common, enforceCurrentAmount: true }), (_req, res) => res.json({ paid: true }));
  app.get("/variable", createL402Middleware({ ...common, amountSats: () => 250 }), (_req, res) => res.json({ paid: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url, invoices, revocations, get verifications() { return verifications; },
    get executions() { return executions; }, setClock: (value: number) => { clock = value; },
    auth(offer: { macaroon: string; payment_hash: string }) {
      return { Authorization: `L402 ${offer.macaroon}:${invoices.get(offer.payment_hash)!.preimage}` };
    },
    async offer(budget = "5000") {
      const response = await fetch(url + "/paid", { headers: { "X-Requested-Budget": budget } });
      assert.equal(response.status, 402);
      return response.json();
    },
    async close() { server.close(); await once(server, "close"); },
  };
}

test("Whale funding and 20 prepaid calls are surge immune; parallel depletion settles once", async () => {
  const ledger = createMemoryRevenueLedger();
  const rig = await harness({ ledger });
  try {
    let ordinary;
    for (let i = 0; i < 122; i++) ordinary = await (await fetch(rig.url + "/paid")).json();
    assert.ok(ordinary.amount_sats > 250);
    const offer = await rig.offer();
    assert.equal(offer.payment_mode, "high-velocity");
    assert.equal(offer.amount_sats, 5000);
    assert.equal(offer.base_fee_sats, 5000);
    assert.equal(offer.load_multiplier, 1);
    assert.equal(offer.surge_immunity, true);
    assert.equal(offer.unit_fee_sats, 250);
    assert.equal(offer.max_requests, 20);
    assert.equal(offer.yield_guarantee_sats, 1050);
    assert.match(offer.payment_bridge_instructions.bulk_funding, /X-Requested-Budget/);
    assert.equal(inspectSubscriptionMacaroon(offer.macaroon, secret)?.highVelocityUnitMsats, 250_000);
    const before = rig.invoices.size;
    const responses = await Promise.all(Array.from({ length: 26 }, () =>
      fetch(rig.url + "/paid", { headers: rig.auth(offer) })));
    assert.equal(responses.filter(response => response.status === 200).length, 20);
    assert.equal(responses.filter(response => response.status === 429).length, 6);
    assert.equal(rig.executions, 20);
    assert.equal(rig.verifications, 1);
    assert.equal(rig.invoices.size, before);
    assert.equal(await ledger.getTotalVolume(), 5000);
  } finally { await rig.close(); }
});

test("Whale input validation, 100-call distinction, expiry, revocation and issuer-only metadata", async () => {
  const rig = await harness();
  try {
    for (const value of ["0", "-1", "5000.0", "5e3", "05000", "5010", "250", "1000001", "9".repeat(100)]) {
      assert.equal((await fetch(rig.url + "/paid", { headers: { "X-Requested-Budget": value } })).status, 400);
    }
    assert.equal(rig.invoices.size, 0);
    assert.equal((await fetch(rig.url + "/paid", { headers: { "X-Requested-Budget": "5000", "X-L402-Batch-Size": "100" } })).status, 400);
    for (const path of ["/fixed", "/variable"]) {
      assert.equal((await fetch(rig.url + path, { headers: { "X-Requested-Budget": "5000" } })).status, 400);
    }
    const hundred = await rig.offer("25000");
    assert.equal(hundred.max_requests, 100);
    assert.equal((await fetch(rig.url + "/paid", { headers: rig.auth(hundred) })).status, 200);
    assert.equal((await fetch(rig.url + "/other", { headers: rig.auth(hundred) })).status, 402);
    assert.equal((await fetch(rig.url + "/variable", { headers: rig.auth(hundred) })).status, 402);
    assert.equal((await fetch(rig.url + "/fixed", { headers: rig.auth(hundred) })).status, 402);
    const pass = inspectSubscriptionMacaroon(hundred.macaroon, secret)!;
    const child = attenuateSubscriptionMacaroon(hundred.macaroon, ["max_requests=1"])!;
    await rig.revocations.revoke(pass.tokenId);
    assert.equal((await fetch(rig.url + "/paid", { headers: rig.auth({ ...hundred, macaroon: child }) })).status, 401);
    const fresh = await rig.offer();
    rig.setClock(inspectSubscriptionMacaroon(fresh.macaroon, secret)!.validUntil * 1000);
    assert.equal((await fetch(rig.url + "/paid", { headers: rig.auth(fresh) })).status, 402, "expired roots retain the existing renewal challenge flow");

    const normal = await (await fetch(rig.url + "/paid")).json();
    const token = JSON.parse(Buffer.from(normal.macaroon, "base64url").toString());
    const forged = "high_velocity=250000:" + "00".repeat(32);
    token.caveats.push(forged);
    token.signature = createHmac("sha256", Buffer.from(token.signature, "hex")).update(forged).digest("hex");
    assert.equal(inspectSubscriptionMacaroon(Buffer.from(JSON.stringify(token)).toString("base64url"), secret), null);
  } finally { await rig.close(); }
});

function payoutInvoice(msats: bigint): string {
  let seconds = Math.floor(Date.now() / 1000);
  const words = Array(7).fill(0);
  for (let i = 6; i >= 0; i--) { words[i] = seconds % 32; seconds = Math.floor(seconds / 32); }
  words.push(1, 1, 20, ...bech32.toWords(Buffer.from(hash(), "hex")));
  const description = bech32.toWords(Buffer.from("mock whale yield"));
  words.push(13, Math.floor(description.length / 32), description.length % 32, ...description, ...Array(104).fill(0));
  return bech32.encode(`lnbc${msats * 10n}p`, words, 4096);
}

test("PostgreSQL Whale quotas persist across adapters and descendants; full bulk yield withdraws once", async () => {
  const schema = "whale_test_" + randomBytes(8).toString("hex");
  assert.match(schema, /^[a-z0-9_]+$/);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const connect = async () => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  };
  const database = { connect, query: async (text: string, values?: unknown[]) => {
    const client = await connect();
    try { return await client.query(text, values); } finally { client.release(); }
  } } as typeof pool;
  const fixture = await connect();
  let rig: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    await fixture.query(`
      CREATE TABLE revenue_ledger (payment_hash text PRIMARY KEY, channel text NOT NULL, sats_received bigint NOT NULL);
      CREATE TABLE private_yield_claims (id text PRIMARY KEY, invoice_payment_hash text NOT NULL UNIQUE,
        invoice_digest text NOT NULL, total_msats bigint NOT NULL, settlement_mode text NOT NULL DEFAULT 'mock', created_at timestamptz NOT NULL);
      CREATE TABLE private_yield_earnings (payment_hash text PRIMARY KEY, provider text NOT NULL,
        gross_msats bigint NOT NULL, earned_msats bigint NOT NULL, balance_msats bigint NOT NULL,
        claim_id text REFERENCES private_yield_claims(id), claimed_at timestamptz);
    `);
    const ledger = createMemoryRevenueLedger();
    const record = ledger.record.bind(ledger);
    ledger.record = async entry => {
      const fresh = await record(entry);
      if (fresh) await fixture.query("INSERT INTO revenue_ledger VALUES ($1,'L402',$2) ON CONFLICT DO NOTHING", [entry.paymentHash, entry.satsReceived]);
      return fresh;
    };
    rig = await harness({ ledger, usageStore: createPostgresMacaroonUsageStore(database),
      configure: (app, now) => registerClaimYieldRoute(app, createPrivateYieldEarnings(database, now),
        { secret, now, logMock: () => {} }) });
    const offer = await rig.offer();
    const pass = inspectSubscriptionMacaroon(offer.macaroon, secret)!;
    const child = attenuateSubscriptionMacaroon(offer.macaroon, ["max_requests=3"])!;
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(rig.url + "/paid", { headers: rig.auth({ ...offer, macaroon: child }) })).status, 200);
    }
    assert.equal((await fetch(rig.url + "/paid", { headers: rig.auth({ ...offer, macaroon: child }) })).status, 429);
    // Rejected child redemption must not consume its ancestor's remaining 17 calls.
    const restarted = createPostgresMacaroonUsageStore(database);
    const results = await Promise.all(Array.from({ length: 25 }, () => restarted.consume(pass.requestLimits, pass.validUntil)));
    assert.equal(results.filter(Boolean).length, 17);
    assert.equal((await fetch(rig.url + "/paid", { headers: rig.auth(offer) })).status, 429);
    assert.equal(await ledger.getTotalVolume(), 5000);
    assert.equal(rig.verifications, 1);
    const withdrawal = await fetch(rig.url + "/api/claim-yield", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macaroons: [offer.macaroon], bolt11_invoice: payoutInvoice(1_050_000n) }),
    });
    assert.equal(withdrawal.status, 200);
    const claim = await withdrawal.json();
    assert.equal(claim.claimed_msats, "1050000");
    assert.equal(claim.claimed_sats, 1050);
    assert.equal(claim.payment_sent, false);
    assert.equal(claim.remaining_balance_msats, "0");
    const replay = await fetch(rig.url + "/api/claim-yield", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macaroons: [child], bolt11_invoice: payoutInvoice(1_050_000n) }),
    });
    assert.equal(replay.status, 409);
  } finally {
    if (rig) await rig.close();
    fixture.release();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
