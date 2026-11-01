import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import { bech32 } from "@scure/base";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import { createL402Middleware } from "../../src/middleware/l402";
import { createSwarmReferralKey, verifySwarmReferralKey } from "../../src/lib/swarm-referral";
import { attenuateSubscriptionMacaroon, inspectSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import { createSwarmRoyalties } from "../../src/lib/swarm-royalties";
import { createPrivateYieldEarnings } from "../../src/lib/private-yield-earnings";
import { registerSwarmReferralRoute } from "../../src/routes/swarm-referral";
import { registerClaimYieldRoute } from "../../src/routes/claim-yield";
import { createMemoryRevenueLedger } from "../../src/services/ledger";
import type { SettlementRouter } from "../../src/services/settlement";
import { migratePayoutFixture, mockCoinosPayout } from "../helpers/coinos-payout";

const secret = "swarm-referral-regression-secret";
const hash = () => randomBytes(32).toString("hex");
const ownerKey = generateSecretKey();
const owner = getPublicKey(ownerKey);
function auth(url: string, method = "GET", body?: unknown, key = ownerKey): string {
  const tags = [["u", url], ["method", method]];
  if (body !== undefined) tags.push(["payload", createHash("sha256").update(JSON.stringify(body)).digest("hex")]);
  return "Nostr " + Buffer.from(JSON.stringify(finalizeEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: "",
  }, key))).toString("base64");
}
function invoice(msats: bigint): string {
  let timestamp = Math.floor(Date.now() / 1000);
  const words = Array(7).fill(0);
  for (let i = 6; i >= 0; i--) { words[i] = timestamp % 32; timestamp = Math.floor(timestamp / 32); }
  words.push(1, 1, 20, ...bech32.toWords(Buffer.from(hash(), "hex")));
  const text = bech32.toWords(Buffer.from("simulated referral claim"));
  words.push(13, Math.floor(text.length / 32), text.length % 32, ...text, ...Array(104).fill(0));
  return bech32.encode(`lnbc${msats * 10n}p`, words, 4096);
}

test("Referral keys authenticate the owner, expiry, secret and exact signed contents", () => {
  const expires = Math.floor(Date.now() / 1000) + 60;
  const key = createSwarmReferralKey(owner, secret, expires);
  assert.equal(verifySwarmReferralKey(key, secret, Date.now()), owner);
  for (const invalid of [undefined, "", "x".repeat(10000), key.replace(owner, "ab".repeat(32)),
    key.slice(0, -1) + (key.endsWith("0") ? "1" : "0")]) {
    assert.equal(verifySwarmReferralKey(invalid, secret, Date.now()), null);
  }
  assert.equal(verifySwarmReferralKey(key, secret, expires * 1000), null);
  assert.equal(verifySwarmReferralKey(key, "different-issuer", Date.now()), null);
});

test("PostgreSQL referral discounts, one-time owner royalties and independent 21% claims", async () => {
  const schema = "swarm_test_" + randomBytes(8).toString("hex");
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
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await database.query(`
      CREATE TABLE revenue_ledger (payment_hash text PRIMARY KEY, channel text NOT NULL, sats_received bigint NOT NULL);
      CREATE TABLE private_yield_claims (id text PRIMARY KEY, invoice_payment_hash text UNIQUE NOT NULL,
        invoice_digest text NOT NULL, total_msats bigint NOT NULL, settlement_mode text NOT NULL DEFAULT 'mock', created_at timestamptz NOT NULL);
      CREATE TABLE private_yield_earnings (payment_hash text PRIMARY KEY, provider text NOT NULL,
        gross_msats bigint NOT NULL, earned_msats bigint NOT NULL, balance_msats bigint NOT NULL,
        claim_id text REFERENCES private_yield_claims(id), claimed_at timestamptz);
    `);
    await migratePayoutFixture(database);
    await database.query(await readFile("../../scripts/sql/swarm-royalties.sql", "utf8"));
    const royalties = createSwarmRoyalties(database);
    const ledger = createMemoryRevenueLedger();
    const record = ledger.record.bind(ledger);
    ledger.record = async entry => {
      await database.query("INSERT INTO revenue_ledger VALUES ($1,'L402',$2) ON CONFLICT DO NOTHING",
        [entry.paymentHash, entry.satsReceived]);
      return record(entry);
    };
    const payments = new Map<string, { amount: number; description: string; preimage: string; settled: boolean }>();
    let walletCalls = 0;
    const wallet: SettlementRouter = {
      isConfigured: () => true, activeProvider: () => "mock", circuitState: () => "closed",
      async createInvoice(input) {
        const preimage = hash();
        const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        payments.set(paymentHash, { amount: input.amountMsats, description: input.description, preimage, settled: false });
        return { invoice: "lnbc1swarm", paymentHash, provider: "mock" };
      },
      async verifyPayment(input) {
        walletCalls++;
        const payment = payments.get(input.paymentHash);
        if (!payment?.settled || input.preimage !== payment.preimage || input.expectedAmountMsats !== payment.amount ||
          input.expectedDescription !== payment.description || input.expectedProvider !== "mock") return "invalid";
        return { settledAt: Math.floor(Date.now() / 1000), provider: "mock" };
      },
    };
    const app = express();
    app.use(express.json());
    app.locals.swarmRoyalties = royalties;
    registerSwarmReferralRoute(app, royalties, { secret });
    registerClaimYieldRoute(app, createPrivateYieldEarnings(database, Date.now, mockCoinosPayout().client), { secret, logSettlement: () => {} });
    const common = { amountSats: 250, scopePath: "/paid", description: "swarm test",
      sessionSecret: secret, settlementRouter: wallet, ledger, allowBatch: true, maxChallengesPerMinute: 1000 };
    app.get("/paid", createL402Middleware(common), (_req, res) => res.json({ paid: true }));
    app.get("/fixed", createL402Middleware({ ...common, scopePath: "/fixed", enforceCurrentAmount: true }),
      (_req, res) => res.json({ paid: true }));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const endpoint = base + "/api/swarm-referral-key";
    assert.equal((await fetch(endpoint)).status, 401);
    const getKey = async () => {
      const response = await fetch(endpoint, { headers: { "X-Nostr-Authorization": auth(endpoint) } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const key = (await getKey()).referral_key;
    assert.equal(verifySwarmReferralKey(key, secret, Date.now()), owner);
    const offer = async (headers: Record<string, string> = {}, path = "/paid") => {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 402);
      return response.json();
    };
    for (const invalid of ["bad", key.slice(0, -2), createSwarmReferralKey(owner, secret, 1)]) {
      const result = await offer({ "X-Swarm-Referral": invalid });
      assert.equal(result.amount_sats, 250);
      assert.equal(result.referral_discount_percent, undefined);
    }
    const coupon = { "X-Swarm-Referral": key };
    const buyerKey = generateSecretKey();
    const quote = await offer({ ...coupon,
      "X-Nostr-Authorization": auth(base + "/paid", "GET", undefined, buyerKey) });
    assert.equal(quote.undiscounted_fee_sats, 250);
    assert.equal(quote.amount_sats, 237.5);
    assert.equal(quote.yield_guarantee_sats, 49.875);
    assert.equal(quote.royalty_fee_sats, 11.875);
    assert.equal((await getKey()).claimable_msats, "0", "Unpaid quotes are never credited");
    const pass = inspectSubscriptionMacaroon(quote.macaroon, secret)!;
    assert.equal(pass.swarmReferral?.owner, owner);
    assert.equal(pass.agentId, getPublicKey(buyerKey));
    assert.notEqual(pass.agentId, owner, "The royalty belongs to a distinct authenticated secondary party");
    const payment = payments.get(quote.payment_hash)!;
    payment.settled = true;
    const headers = { Authorization: `L402 ${quote.macaroon}:${payment.preimage}`,
      "X-Nostr-Authorization": auth(base + "/paid", "GET", undefined, buyerKey),
      "X-Swarm-Referral": createSwarmReferralKey(getPublicKey(generateSecretKey()), secret, Math.floor(Date.now() / 1000) + 60) };
    const paid = await Promise.all(Array.from({ length: 8 }, () => fetch(base + "/paid", { headers })));
    assert.equal(paid.filter(response => response.status === 200).length, 1);
    assert.equal(paid.filter(response => response.status === 429).length, 7);
    assert.equal(walletCalls, 1);
    let balance = await getKey();
    assert.equal(balance.claimable_msats, "11875");
    assert.deepEqual(balance.royalty_payment_hashes, [quote.payment_hash]);
    const stored = await database.query("SELECT * FROM private_swarm_royalties");
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].owner, owner, "Retry headers cannot replace the invoice's owner");
    assert.equal(stored.rows[0].gross_msats, "237500");
    const claimUrl = base + "/api/claim-yield";
    const body = { royalty_payment_hashes: [quote.payment_hash], bolt11_invoice: invoice(11875n) };
    const claim = (payload: unknown, signer = ownerKey, signed = true) => fetch(claimUrl, {
      method: "POST", headers: { "Content-Type": "application/json",
        ...(signed ? { "X-Nostr-Authorization": auth(claimUrl, "POST", payload, signer) } : {}) },
      body: JSON.stringify(payload),
    });
    assert.equal((await claim(body, ownerKey, false)).status, 401);
    assert.equal((await claim(body, generateSecretKey())).status, 403);
    assert.equal((await claim({ ...body, bolt11_invoice: invoice(12000n) })).status, 400);
    app.locals.swarmReferralRevoked = async () => true;
    assert.equal((await claim(body)).status, 403);
    delete app.locals.swarmReferralRevoked;
    const claims = await Promise.all([claim(body), claim(body)]);
    assert.equal(claims.filter(response => response.status === 200).length, 1);
    assert.ok(claims.filter(response => response.status !== 200).every(response =>
      response.status === 202 || response.status === 409), "An in-flight duplicate is pending or already settled, never repaid");
    const result = await claims.find(response => response.status === 200)!.json();
    assert.equal(result.claimed_msats, "11875");
    assert.equal(result.payment_sent, true);
    assert.equal((await getKey()).claimable_msats, "0");
    // Exact historical 21% buyer earnings stay separate, even after the owner claims.
    const buyer = await claim({ macaroons: [quote.macaroon], bolt11_invoice: invoice(49875n) }, ownerKey, false);
    assert.equal(buyer.status, 200);
    assert.equal((await buyer.json()).claimed_msats, "49875");
    assert.equal((await claim({ macaroons: [quote.macaroon], bolt11_invoice: invoice(49875n) }, ownerKey, false)).status, 409);
    // Wholesale funding and authoritative tolls do not participate.
    const whale = await offer({ ...coupon, "X-Requested-Budget": "5000" });
    assert.equal(whale.amount_sats, 5000);
    assert.equal(whale.max_requests, 20);
    assert.equal(whale.surge_immunity, true);
    assert.equal(inspectSubscriptionMacaroon(whale.macaroon, secret)?.swarmReferral, undefined);
    assert.equal((await offer(coupon, "/fixed")).amount_sats, 250);
    // The unchanged surge fee is discounted only after it is computed.
    let surge;
    for (let i = 0; i < 121; i++) surge = await offer(coupon);
    assert.ok(surge.load_multiplier > 1);
    assert.equal(surge.amount_sats * 1000, surge.undiscounted_fee_sats * 950);
    // A holder can append HMAC caveats, but cannot create issuer-only privileges.
    const normal = await offer();
    const token = JSON.parse(Buffer.from(normal.macaroon, "base64url").toString());
    const forged = `swarm_referral=${owner}:250000:${"00".repeat(32)}`;
    token.caveats.push(forged);
    token.signature = createHmac("sha256", Buffer.from(token.signature, "hex")).update(forged).digest("hex");
    assert.equal(inspectSubscriptionMacaroon(Buffer.from(JSON.stringify(token)).toString("base64url"), secret), null);
    const child = attenuateSubscriptionMacaroon(quote.macaroon, ["max_requests=1"])!;
    assert.equal(inspectSubscriptionMacaroon(child, secret)?.swarmReferral?.owner, owner);
    const final = await database.query("SELECT total_msats::text FROM private_yield_claims ORDER BY total_msats");
    assert.deepEqual(final.rows.map(row => row.total_msats), ["11875", "49875"]);
  } finally {
    if (server) { server.close(); await once(server, "close"); }
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
