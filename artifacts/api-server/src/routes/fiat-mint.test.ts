// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import pg from "pg";
import Stripe from "stripe";
import { bech32 } from "@scure/base";
import { pinVerifiedSslMode } from "@workspace/db/connection-string";
import {
  FiatMint,
  validFiatSession,
  fiatOwnerHash,
} from "../services/fiatMint";
import type { SettlementProvider } from "../services/settlement/types";
import type { NwcPayout } from "../lib/nwc-payout";
import { inspectSubscriptionMacaroon } from "../lib/subscription-pass";
import { registerFiatMintRoutes, registerFiatWebhook } from "./fiat-mint";

const session = (id: string, sessionId: string) =>
  ({
    id: sessionId,
    livemode: false,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 50_000,
    currency: "usd",
    metadata: { fiat_order_id: id, fiat_product: "scanner-100-v1" },
    url: "https://checkout.stripe.com/c/pay/synthetic",
  }) as unknown as Stripe.Checkout.Session;

test("fiat settlement accepts only the exact paid test session and product", () => {
  const order = { id: "synthetic", session_id: "cs_test_synthetic" };
  const good = session(order.id, order.session_id);
  assert.equal(validFiatSession(good, order), true);
  for (const patch of [
    { livemode: true },
    { amount_total: 49999 },
    { currency: "eur" },
    { payment_status: "unpaid" },
    { status: "open" },
    { mode: "subscription" },
    { id: "different" },
    { metadata: { fiat_order_id: "other", fiat_product: "scanner-100-v1" } },
  ]) {
    assert.equal(
      validFiatSession({ ...good, ...patch } as Stripe.Checkout.Session, order),
      false,
    );
  }
});

test("raw Stripe signatures, same-origin ownership and one-time UI contracts", async () => {
  const stripe = new Stripe("sk_test_synthetic_never_a_real_key");
  const signingSecret = "whsec_synthetic_never_a_real_secret";
  let calls = 0;
  const app = express();
  registerFiatWebhook(app, async (body, sig) => {
    stripe.webhooks.constructEvent(body, sig, signingSecret);
    calls++;
  });
  app.use(express.json());
  const mint = {
    checkout: async () => "https://checkout.stripe.com/c/pay/synthetic",
    status: async () => "ready",
    claim: async () => null,
  } as unknown as FiatMint;
  registerFiatMintRoutes(app, mint, () => "https://example.test");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    });
  try {
    const payload = JSON.stringify({
      id: "evt_synthetic",
      type: "checkout.session.completed",
      data: { object: {} },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
    });
    assert.equal(
      (
        await post("/api/stripe/webhook", payload, {
          "stripe-signature": signature,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post("/api/stripe/webhook", payload + " ", {
          "stripe-signature": signature,
        })
      ).status,
      400,
    );
    assert.equal((await post("/api/stripe/webhook", payload)).status, 400);
    assert.equal(calls, 1);
    assert.equal(
      (await post("/api/fiat-mint", "{}", { origin: "https://evil.test" }))
        .status,
      403,
    );
    const owned = await post("/api/fiat-mint", "{}", {
      origin: "https://example.test",
    });
    assert.equal(owned.status, 200);
    const cookie = owned.headers.get("set-cookie")!;
    for (const flag of [
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/api/fiat-mint",
    ])
      assert.ok(cookie.includes(flag));
    const invalid = await post("/api/fiat-mint", '{"amount":1}', {
      origin: "https://example.test",
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (
        await post("/api/fiat-mint/claim", "{}", {
          origin: "https://example.test",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("/api/fiat-mint/status", "{}", {
          origin: "https://example.test",
        })
      ).headers.get("cache-control"),
      "no-store",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("PostgreSQL fiat fulfillment is crash-safe, capped, owner-bound and never re-pays", async (t) => {
  const schema = `fiat_test_${randomBytes(8).toString("hex")}`;
  const pool = new pg.Pool({
    connectionString: pinVerifiedSslMode(process.env.DATABASE_URL!),
    options: `-c search_path=${schema}`,
    max: 5,
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`CREATE TABLE fiat_mint_orders (
    id text PRIMARY KEY,owner_hash text UNIQUE NOT NULL,status text NOT NULL DEFAULT 'checkout',
    session_id text UNIQUE,invoice text,payment_hash text UNIQUE,macaroon text,valid_until integer,
    reserved_sats integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now())`);
  let pays = 0,
    invoices = 0,
    incoming = true,
    outgoing = true,
    ambiguous = false,
    enabled = true,
    budget = 2_000_000;
  let crashAfterPay = false;
  let currentPreimage = "";
  const merchant: SettlementProvider = {
    name: "coinos",
    isConfigured: () => true,
    createInvoice: async (input) => {
      invoices++;
      assert.equal(input.amountMsats, 100_000_000);
      currentPreimage = randomBytes(32).toString("hex");
      const hash = createHash("sha256")
        .update(Buffer.from(currentPreimage, "hex"))
        .digest("hex");
      let timestamp = Math.floor(Date.now() / 1000);
      const words = Array<number>(7).fill(0);
      for (let i = 6; i >= 0; i--) {
        words[i] = timestamp % 32;
        timestamp = Math.floor(timestamp / 32);
      }
      const hashWords = bech32.toWords(Buffer.from(hash, "hex"));
      return {
        invoice: bech32.encode(
          "lnbc1m",
          [...words, 1, 1, 20, ...hashWords, ...Array<number>(104).fill(0)],
          4096,
        ),
        paymentHash: hash,
        provider: "coinos",
      };
    },
    verifyPayment: async (input) => {
      assert.equal(input.expectedProvider, "coinos");
      assert.equal(input.expectedAmountMsats, 100_000_000);
      return incoming ? { settledAt: 1, provider: "coinos" } : "invalid";
    },
  };
  const payer: NwcPayout = {
    configured: () => true,
    pay: async () => {
      pays++;
      if (crashAfterPay)
        throw new Error("synthetic crash after wallet submission");
      return ambiguous
        ? { status: "pending" }
        : { status: "settled", preimage: currentPreimage };
    },
    lookup: async () =>
      outgoing
        ? { status: "settled", preimage: currentPreimage }
        : { status: "pending" },
  };
  const secret = "synthetic-fiat-issuer-only-secret";
  let stripeSession: Stripe.Checkout.Session | undefined;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => stripeSession,
        listLineItems: async () => ({
          data: [{ quantity: 1, price: { id: "price_test_synthetic" } }],
          has_more: false,
        }),
      },
    },
  } as unknown as Stripe;
  const mint = new FiatMint({
    pool,
    merchant,
    payer,
    stripe: async () => stripe,
    priceId: () => "price_test_synthetic",
    origin: () => "https://example.test",
    secret: () => secret,
    allowTreasury: () => enabled,
    budgetSats: () => budget,
  });
  async function order(status = "paid") {
    const owner = randomBytes(32).toString("hex");
    const id = randomBytes(16).toString("hex");
    await pool.query(
      "INSERT INTO fiat_mint_orders(id,owner_hash,status,session_id) VALUES($1,$2,$3,$4)",
      [id, fiatOwnerHash(owner), status, `cs_test_${id}`],
    );
    return { owner, id };
  }
  try {
    await t.test(
      "test charges alone never spend while the treasury opt-in is off",
      async () => {
        const row = await order();
        enabled = false;
        await mint.fulfill(row.id);
        assert.equal(pays, 0);
        assert.equal(invoices, 0);
        enabled = true;
      },
    );
    await t.test("zero budget cannot create or pay invoices", async () => {
      const row = await order();
      budget = 0;
      await mint.fulfill(row.id);
      assert.equal(pays, 0);
      assert.equal(invoices, 0);
      budget = 2_000_000;
    });
    await t.test(
      "paid test session recovery and repeated webhook events do not mint twice",
      async () => {
        const row = await order("checkout");
        stripeSession = session(row.id, `cs_test_${row.id}`);
        stripeSession.payment_status = "unpaid";
        await mint.acceptSession(stripeSession.id);
        assert.equal(
          (
            await pool.query(
              "SELECT status FROM fiat_mint_orders WHERE id=$1",
              [row.id],
            )
          ).rows[0].status,
          "checkout",
        );
        stripeSession.payment_status = "paid";
        await Promise.all([
          mint.acceptSession(stripeSession.id),
          mint.acceptSession(stripeSession.id),
        ]);
        assert.equal(await mint.status(row.owner), "paid");
        const before = pays;
        await Promise.all([mint.fulfill(row.id), mint.fulfill(row.id)]);
        await mint.fulfill(row.id);
        assert.equal(pays, before + 1);
        assert.equal(await mint.status(row.owner), "ready");
        assert.equal(await mint.claim("unrelated-owner"), null);
        const [first, second] = await Promise.all([
          mint.claim(row.owner),
          mint.claim(row.owner),
        ]);
        const grants = [first, second].filter(Boolean);
        assert.equal(grants.length, 1);
        assert.equal(grants[0]!.credits, 100);
        const capability = inspectSubscriptionMacaroon(
          grants[0]!.macaroon,
          secret,
        )!;
        assert.equal(capability.scannerCredits, 100);
        assert.deepEqual(capability.allowedPaths, ["/api/scanner"]);
        assert.equal(await mint.status(row.owner), "delivered");
      },
    );
    await t.test(
      "ambiguous wallet outcomes keep the same invoice and never re-pay",
      async () => {
        const row = await order();
        ambiguous = true;
        outgoing = false;
        const before = pays;
        await mint.fulfill(row.id);
        const original = (
          await pool.query(
            "SELECT payment_hash FROM fiat_mint_orders WHERE id=$1",
            [row.id],
          )
        ).rows[0];
        await mint.fulfill(row.id);
        assert.equal(pays, before + 1);
        assert.equal(await mint.status(row.owner), "paying");
        outgoing = true;
        ambiguous = false;
        incoming = false;
        await mint.fulfill(row.id);
        assert.equal(await mint.status(row.owner), "paying");
        incoming = true;
        await mint.fulfill(row.id);
        assert.equal(await mint.status(row.owner), "ready");
        assert.equal(pays, before + 1);
        assert.equal(
          (
            await pool.query(
              "SELECT payment_hash FROM fiat_mint_orders WHERE id=$1",
              [row.id],
            )
          ).rows[0].payment_hash,
          original.payment_hash,
        );
      },
    );
    await t.test(
      "process failure after pay reservation resumes lookup only",
      async () => {
        const row = await order();
        crashAfterPay = true;
        const before = pays;
        await assert.rejects(mint.fulfill(row.id), /synthetic crash/);
        assert.equal(await mint.status(row.owner), "paying");
        crashAfterPay = false;
        await mint.fulfill(row.id);
        assert.equal(await mint.status(row.owner), "ready");
        assert.equal(pays, before + 1);
      },
    );
  } finally {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
