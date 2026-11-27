// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { assertNextAction } from "../lib/testing/next-action";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import Stripe from "stripe";
import type { CreateFiatMintCheckout402, ScannerCreditGrant } from "@workspace/api-zod";
import { registerFiatMintRoutes } from "./fiat-mint";
import { createScannerMintHandler, registerScannerRoute } from "./scanner";
import type { FiatMint } from "../services/fiatMint";
import type { SettlementRouter } from "../services/settlement";
import { createMemoryMacaroonUsageStore } from "../lib/macaroon-usage-store";
import { attenuateSubscriptionMacaroon } from "../lib/subscription-pass";
import { SCANNER_CREDIT_DESCRIPTION } from "../lib/scanner-credits";
import { isFiatGatewayOffline, withFiatGatewayDeadline } from "../services/fiatContinuity";

const origin = "https://continuity.test";
const preimage = "a".repeat(64);
const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const offline = (statusCode = 503) => new Stripe.errors.StripeAPIError({
  message: "Synthetic upstream outage", statusCode,
});

async function fixture(options: {
  checkout?: () => Promise<string>;
  eligible?: () => Promise<boolean>;
  invoiceFailure?: boolean;
} = {}) {
  let checkoutCalls = 0;
  let invoices = 0;
  let paid = false;
  let recoveryCalls = 0;
  const router: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "synthetic-native",
    circuitState: () => "closed",
    createInvoice: async (input) => {
      invoices++;
      assert.equal(input.amountMsats, 100_000_000);
      assert.equal(input.description, SCANNER_CREDIT_DESCRIPTION);
      assert.equal(input.asset, "btc-lightning");
      assert.equal(input.expirySeconds, 900);
      if (options.invoiceFailure) throw new Error("Synthetic native outage");
      return { invoice: "lnbc1syntheticcontinuity", paymentHash, provider: "synthetic-native", asset: "btc-lightning" };
    },
    verifyPayment: async (input) => {
      assert.equal(input.paymentHash, paymentHash);
      assert.equal(input.expectedAmountMsats, 100_000_000);
      assert.equal(input.expectedDescription, SCANNER_CREDIT_DESCRIPTION);
      return paid ? { settledAt: Math.floor(Date.now() / 1000), provider: "synthetic-native", asset: "btc-lightning" } : "invalid";
    },
  };
  const mint = {
    checkout: async () => {
      checkoutCalls++;
      return options.checkout ? options.checkout() : "https://checkout.stripe.com/c/pay/synthetic";
    },
    canOfferNativeFallback: options.eligible ?? (async () => true),
    status: async () => { recoveryCalls++; return "checkout"; },
    claim: async () => null,
  } as unknown as FiatMint;
  const paymentOptions = {
    settlementRouter: router,
    spotOracle: { quote: async () => ({ btcUsd: 450000, observedAt: Date.now() }) },
    sessionSecret: "synthetic-continuity-secret-never-a-real-credential",
    usageStore: createMemoryMacaroonUsageStore(),
  };
  const app = express();
  app.use(express.json());
  registerFiatMintRoutes(app, mint, () => origin, {
    nativeLightning: createScannerMintHandler(paymentOptions, true),
    timeoutMs: 20,
  });
  registerScannerRoute(app, paymentOptions);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    post: (path = "/api/fiat-mint", body: unknown = {}, headers: Record<string, string> = {}) => fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    }),
    counts: () => ({ checkoutCalls, invoices, recoveryCalls }),
    pay: () => { paid = true; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("healthy Stripe checkout response and ownership cookie are unchanged; no native invoice", async () => {
  const f = await fixture();
  try {
    const res = await f.post();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: "https://checkout.stripe.com/c/pay/synthetic" });
    assert.match(res.headers.get("set-cookie")!, /HttpOnly/);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.equal(f.counts().invoices, 0);
    assert.equal(f.counts().checkoutCalls, 1);
  } finally { await f.close(); }
});

for (const failure of [500, 502, 503, 504, 599]) {
  test(`Stripe HTTP ${failure} returns a native 402 with matching machine-readable header/body`, async () => {
    const f = await fixture({ checkout: async () => { throw offline(failure); } });
    try {
      const res = await f.post();
      assert.equal(res.status, 402);
      const body = await res.json() as CreateFiatMintCheckout402;
      assert.match(res.headers.get("www-authenticate")!, /error="fiat_gateway_offline", fallback="native_lightning_active"/);
      assert.ok(res.headers.get("www-authenticate")!.includes(`macaroon="${body.macaroon}"`));
      assert.ok(res.headers.get("www-authenticate")!.includes(`invoice="${body.invoice}"`));
      assert.equal(body.error, "fiat_gateway_offline");
      assert.equal(body.fallback, "native_lightning_active");
      assert.equal(body.amount_sats, 100_000);
      assert.equal(body.credits, 100);
      assert.equal(body.payment_endpoint, "/api/mint-macaroon");
      assert.equal(body.purchase_recovery, "/api/fiat-mint/status");
      assertNextAction(body, "fiat_gateway_offline", "POST", body.payment_endpoint);
      assert.equal(body.next_action?.alternatives, undefined);
      assert.equal(res.headers.has("PAYMENT-REQUIRED"), false);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(f.counts().checkoutCalls, 1);
      assert.equal(f.counts().invoices, 1);
    } finally { await f.close(); }
  });
}

test("hung checkout falls back at bounded deadline; late creation stays observable without retry", async () => {
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const f = await fixture({ checkout: () => pending });
  try {
    const res = await f.post();
    assert.equal(res.status, 402);
    finish("https://checkout.stripe.com/c/pay/late");
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const recovered = await f.post("/api/fiat-mint/status", {}, { cookie });
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { status: "checkout" });
    assert.deepEqual(f.counts(), { checkoutCalls: 1, invoices: 1, recoveryCalls: 1 });
  } finally { finish(""); await f.close(); }
});

test("late primary rejection is observed after the deadline, not retried", async () => {
  let fail!: (error: Error) => void;
  const primary = new Promise<string>((_, reject) => { fail = reject; });
  await assert.rejects(withFiatGatewayDeadline(() => primary, 1), /deadline/);
  fail(new Error("Late synthetic failure"));
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test("SDK timeout qualifies; 4xx, local errors and forged status values do not", async () => {
  const timeout = new Stripe.errors.StripeConnectionError({ message: "Request timed out", code: "ETIMEDOUT" });
  assert.equal(isFiatGatewayOffline(timeout), true);
  for (const error of [
    new Error("Database unavailable"),
    { statusCode: 503 },
    new Stripe.errors.StripeAuthenticationError({ message: "Denied", statusCode: 401 }),
    new Stripe.errors.StripeRateLimitError({ message: "Rate limit", statusCode: 429 }),
    new Stripe.errors.StripeInvalidRequestError({ message: "Invalid", statusCode: 400 }),
  ]) assert.equal(isFiatGatewayOffline(error), false);
  const f = await fixture({ checkout: async () => { throw timeout; } });
  try { assert.equal((await f.post()).status, 402); }
  finally { await f.close(); }
});

for (const error of [new Error("Local configuration error"), new Stripe.errors.StripeInvalidRequestError({ message: "Invalid", statusCode: 400 })]) {
  test(`non-outage ${error.name} does not invoke native Lightning`, async () => {
    const f = await fixture({ checkout: async () => { throw error; } });
    try {
      assert.equal((await f.post()).status, 503);
      assert.equal(f.counts().invoices, 0);
    } finally { await f.close(); }
  });
}

for (const eligible of [async () => false, async (): Promise<boolean> => { throw new Error("Recovery DB down"); }]) {
  test("existing payable/paid purchase or failed recovery lookup blocks second-payment fallback", async () => {
    const f = await fixture({ checkout: async () => { throw offline(); }, eligible });
    try {
      const res = await f.post();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("www-authenticate"), null);
      assert.equal(f.counts().invoices, 0);
      assert.equal((await res.json() as { next_action?: unknown }).next_action, undefined);
    } finally { await f.close(); }
  });
}

test("outage challenge uses the original native verifier; unpaid and path-tampered tokens are denied", async () => {
  const f = await fixture({ checkout: async () => { throw offline(); } });
  try {
    const res = await f.post();
    const body = await res.json() as CreateFiatMintCheckout402;
    const auth = { authorization: `L402 ${body.macaroon}:${preimage}` };
    const unpaid = await f.post(body.payment_endpoint, {}, {
      authorization: `Macaroon ${body.macaroon}`,
    });
    assert.equal(unpaid.status, 409);
    f.pay();
    const narrowed = attenuateSubscriptionMacaroon(body.macaroon, ["allowed_path=/api/other"]);
    const tampered = await f.post(body.payment_endpoint, {}, { authorization: `L402 ${narrowed}:${preimage}` });
    assert.equal(tampered.status, 403);
    const paid = await f.post(body.payment_endpoint, {}, auth);
    assert.equal(paid.status, 200);
    const grant = await paid.json() as ScannerCreditGrant;
    assert.equal(grant.macaroon, body.macaroon);
    assert.equal(grant.credits, 100);
    assert.equal(grant.scope, "/api/scanner");
    assert.equal(grant.amount_sats, 100_000);
    assert.equal(f.counts().checkoutCalls, 1);
    assert.equal(f.counts().invoices, 1);
  } finally { await f.close(); }
});

test("dual outage fails closed without a misleading active-fallback header", async () => {
  const f = await fixture({ checkout: async () => { throw offline(); }, invoiceFailure: true });
  try {
    const res = await f.post();
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.deepEqual(await res.json(), { error: "Unable to create payment invoice" });
  } finally { await f.close(); }
});

test("origin, body and fixed-product guards still reject invalid fallback requests", async () => {
  const f = await fixture({ checkout: async () => { throw offline(); } });
  try {
    assert.equal((await f.post(undefined, {}, { origin: "https://evil.test" })).status, 403);
    assert.equal((await f.post(undefined, { amount: 1 })).status, 400);
    for (const header of ["X-Requested-Budget", "X-L402-Batch-Size", "X-Swarm-Referral"]) {
      assert.equal((await f.post(undefined, {}, { [header]: "100" })).status, 400);
    }
    assert.equal(f.counts().invoices, 0);
  } finally { await f.close(); }
});
