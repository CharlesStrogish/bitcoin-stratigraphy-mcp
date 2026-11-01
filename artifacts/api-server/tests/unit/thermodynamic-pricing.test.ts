import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { createThermodynamicPricing } from "../../src/lib/thermodynamic-pricing";
import { createL402Middleware } from "../../src/middleware/l402";
import { createSubscriptionMacaroon, inspectSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import type { SettlementRouter } from "../../src/services/settlement";

test("thermodynamic pricing rises with admitted load, caps, resets and preserves exact yield", () => {
  let clock = 0;
  const quote = createThermodynamicPricing(() => clock);
  for (let i = 0; i < 120; i++) assert.equal(quote(100).amountSats, 100);
  const surge = quote(100);
  assert.equal(surge.amountSats, 101);
  assert.equal(surge.yieldGuaranteeSats, 21.21);
  for (let i = 0; i < 1000; i++) quote(100);
  assert.equal(quote(100).amountSats, 300);
  assert.equal(quote(100, 100).amountSats, 30_000);
  assert.equal(quote(100, 1, true).amountSats, 100);
  clock += 60_000;
  assert.equal(quote(100).amountSats, 100);
  assert.equal(quote(5).yieldGuaranteeSats, 1.05);
  assert.throws(() => quote(Number.MAX_SAFE_INTEGER), /safe millisatoshi/);
  assert.throws(() => quote(0), /positive safe integer/);
  const exact = createThermodynamicPricing(() => 0);
  for (let i = 0; i < 122; i++) exact(240);
  assert.equal(exact(240).amountSats, 243);
});

test("holders cannot retrofit an issuer base price onto a legacy asset-bound credential", () => {
  const secret = "thermodynamic-legacy-secret";
  const original = createSubscriptionMacaroon({
    secret, paymentHash: "ab".repeat(32), tier: "1-day", validUntil: 3600,
    amountMsats: 100_000, paymentAsset: "btc-lightning", paymentProvider: "test-wallet",
  });
  assert.equal(inspectSubscriptionMacaroon(original, secret)?.amountMsats, 100_000);
  const token = JSON.parse(Buffer.from(original, "base64url").toString("utf8"));
  const caveat = "base_amount_msats=50000";
  // A macaroon holder can compute an appended HMAC without the issuer secret.
  token.signature = createHmac("sha256", Buffer.from(token.signature, "hex")).update(caveat).digest("hex");
  token.caveats.push(caveat);
  const forged = Buffer.from(JSON.stringify(token)).toString("base64url");
  assert.equal(inspectSubscriptionMacaroon(forged, secret), null);
});

test("surge invoice, 402 oracle and signed amount agree; paid credentials survive load changes", async () => {
  let clock = 0;
  const preimage = "01".repeat(32);
  const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const secret = "thermodynamic-regression-secret";
  let issuedAmount = 0;
  let checkedAmount = 0;
  const router: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "test-wallet",
    circuitState: () => "closed",
    async createInvoice(input) {
      issuedAmount = input.amountMsats;
      return { invoice: "lnbc1test", paymentHash, provider: "test-wallet" };
    },
    async verifyPayment(input) {
      checkedAmount = input.expectedAmountMsats!;
      return checkedAmount === issuedAmount && input.preimage === preimage
        ? { settledAt: 1, provider: "test-wallet" } : "invalid";
    },
  };
  const app = express();
  const gate = (amountSats: number, enforceCurrentAmount = false) => createL402Middleware({
    amountSats, enforceCurrentAmount, description: "surge test",
    scopePath: "/paid", settlementRouter: router, sessionSecret: secret,
    maxChallengesPerMinute: 1000, now: () => clock, allowBatch: true,
  });
  app.get("/paid", gate(100), (_req, res) => res.json({ paid: true }));
  app.get("/different-base", gate(101), (_req, res) => res.json({ paid: true }));
  app.get("/fixed", gate(100, true), (_req, res) => res.json({ paid: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (let i = 0; i < 120; i++) {
      const response = await fetch(base + "/paid");
      assert.equal(response.status, 402);
      await response.arrayBuffer();
    }
    const response = await fetch(base + "/paid");
    assert.equal(response.status, 402);
    const offer = await response.json() as Record<string, any>;
    assert.equal(offer.dynamic_fee_sats, 101);
    assert.equal(offer.amount_sats, offer.dynamic_fee_sats);
    assert.equal(offer.yield_guarantee_sats, 21.21);
    assert.equal(offer.ev_status, "POSITIVE_EXPECTED_VALUE");
    assert.equal(offer.staged_preview.quoted_toll_sats, 101);
    assert.equal(issuedAmount, 101_000);
    const pass = inspectSubscriptionMacaroon(offer.macaroon, secret);
    assert.equal(pass?.amountMsats, issuedAmount);
    assert.equal(pass?.baseAmountMsats, 100_000);
    const auth = { Authorization: `L402 ${offer.macaroon}:${preimage}` };
    clock = 60_000; // Current load is now back at base; the old quote must still settle.
    const paid = await fetch(base + "/paid", { headers: auth });
    assert.equal(paid.status, 200);
    assert.equal(checkedAmount, 101_000);
    // Same signed path and final amount cannot authorize a different base-price product.
    assert.equal((await fetch(base + "/different-base", { headers: auth })).status, 402);
    assert.equal((await fetch(base + "/fixed", { headers: auth })).status, 402);
    const batch = await fetch(base + "/paid", { headers: { "X-L402-Batch-Size": "100" } });
    const batchOffer = await batch.json() as Record<string, any>;
    assert.equal(batchOffer.dynamic_fee_sats, 10_000);
    assert.equal(batchOffer.yield_guarantee_sats, 2100);
    assert.equal(inspectSubscriptionMacaroon(batchOffer.macaroon, secret)?.amountMsats, issuedAmount);
  } finally {
    server.close();
    await once(server, "close");
  }
});
