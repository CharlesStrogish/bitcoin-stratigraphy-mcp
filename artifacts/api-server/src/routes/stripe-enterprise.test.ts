// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import pg from "pg";
import Stripe from "stripe";
import { bech32 } from "@scure/base";
import { pinVerifiedSslMode } from "@workspace/db/connection-string";
import { registerFiatWebhook } from "./fiat-mint";
import { verifyEnterpriseWebhook } from "../services/enterpriseWebhook";
import {
  createEnterpriseMailer,
  enterpriseEmailBody,
  ENTERPRISE_SENDER,
  ENTERPRISE_SUBJECT,
} from "../services/enterpriseEmail";
import {
  EnterpriseFulfillment,
  ENTERPRISE_PAYMENT_LINK,
} from "../services/enterpriseFulfillment";
import { FiatMint } from "../services/fiatMint";
import { inspectSubscriptionMacaroon } from "../lib/subscription-pass";
import type { SettlementProvider } from "../services/settlement/types";
import type { NwcPayout } from "../lib/nwc-payout";

const signingSecret = "whsec_synthetic_local_webhook_tests_only";
const issuerSecret = "synthetic-local-macaroon-signing-secret";
function signedEvent(
  type = "checkout.session.completed",
  timestamp?: number,
  sessionId = "cs_test_enterprise",
) {
  const body = JSON.stringify({
    id: "evt_test_enterprise",
    object: "event",
    livemode: false,
    type,
    data: { object: { id: sessionId, livemode: false } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: signingSecret,
    ...(timestamp ? { timestamp } : {}),
  });
  return { body, signature };
}

test("official Stripe verification rejects forged, tampered, stale and missing-secret requests", () => {
  const { body, signature } = signedEvent();
  assert.equal(
    verifyEnterpriseWebhook(Buffer.from(body), signature, signingSecret)?.id,
    "evt_test_enterprise",
  );
  for (const [payload, sig, secret] of [
    [body + " ", signature, signingSecret],
    [body, signature, "whsec_wrong_test_secret"],
    [
      body,
      signedEvent("checkout.session.completed", 1).signature,
      signingSecret,
    ],
  ]) {
    assert.throws(() =>
      verifyEnterpriseWebhook(Buffer.from(payload!), sig!, secret),
    );
  }
  assert.throws(() =>
    verifyEnterpriseWebhook(Buffer.from(body), signature, undefined),
  );
  const ignored = signedEvent("payment_intent.succeeded");
  assert.equal(
    verifyEnterpriseWebhook(
      Buffer.from(ignored.body),
      ignored.signature,
      signingSecret,
    ),
    null,
  );
});

test("Brevo official SDK sends the exact requested sender, subject, body and reply address", async () => {
  let captured: Record<string, any> | undefined;
  let calls = 0;
  const send = createEnterpriseMailer({
    apiKey: "synthetic-brevo-test-key",
    fetcher: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.brevo.com/v3/smtp/email");
      captured = JSON.parse(String(init!.body));
      return new Response(
        JSON.stringify({ messageId: "<local-brevo-message>" }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });
  assert.equal(
    await send("buyer@example.test", "unique-test-macaroon", "delivery-test"),
    "<local-brevo-message>",
  );
  assert.equal(calls, 1);
  assert.deepEqual(captured!.sender, { email: ENTERPRISE_SENDER });
  assert.deepEqual(captured!.replyTo, { email: ENTERPRISE_SENDER });
  assert.deepEqual(captured!.to, [{ email: "buyer@example.test" }]);
  assert.equal(captured!.subject, ENTERPRISE_SUBJECT);
  assert.equal(
    captured!.textContent,
    "Hello,\n\nYour $500 payment for the Bitcoin Stratigraphy Enterprise API Block has cleared. Your autonomous swarms are now cleared to route through our Zero-Knowledge architecture for drop-in EU AI Act compliance.\n\nYour L402 Macaroon / API Key: unique-test-macaroon\n\nPlease inject this credential into your environment variables as BITCOIN_STRATIGRAPHY_API_KEY. The Flight Recorder dashboard and your L402 Interceptor will automatically detect the key and resume swarm operations.\n\nIf you have any technical issues scaling this deployment, reply directly to this email.\n\nBest,\nCharles Strogish\nArchitect, BitcoinStratigraphy.com",
  );
});

test("raw enterprise endpoint rejects spoofed signatures before fulfillment", async () => {
  const app = express();
  let calls = 0;
  registerFiatWebhook(
    app,
    async (body, signature) => {
      if (verifyEnterpriseWebhook(body, signature, signingSecret)) calls++;
    },
    "/api/webhook/stripe",
  );
  app.use(express.json());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhook/stripe`;
  async function post(body: string, signature?: string) {
    return fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        ...(signature ? { "stripe-signature": signature } : {}),
      },
    });
  }
  try {
    const valid = signedEvent();
    assert.equal((await post(valid.body, valid.signature)).status, 200);
    assert.equal((await post(valid.body + " ", valid.signature)).status, 400);
    assert.equal((await post(valid.body)).status, 400);
    const ignored = signedEvent("checkout.session.async_payment_succeeded");
    assert.equal((await post(ignored.body, ignored.signature)).status, 200);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture() {
  const schema = `enterprise_email_test_${randomBytes(8).toString("hex")}`;
  const pool = new pg.Pool({
    connectionString: pinVerifiedSslMode(process.env.DATABASE_URL!),
    options: `-c search_path=${schema}`,
    max: 6,
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`CREATE TABLE fiat_mint_orders (
    id text PRIMARY KEY,owner_hash text UNIQUE NOT NULL,status text NOT NULL DEFAULT 'checkout',
    session_id text UNIQUE,invoice text,payment_hash text UNIQUE,macaroon text,valid_until integer,
    reserved_sats integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE stripe_enterprise_deliveries (
    session_id text PRIMARY KEY, order_id text UNIQUE NOT NULL REFERENCES fiat_mint_orders(id),
    recipient text NOT NULL,event_id text NOT NULL,state text NOT NULL DEFAULT 'pending',
    message_id text,send_started_at timestamptz,delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now())`);
  const state = {
    pays: 0,
    invoices: 0,
    updates: 0,
    settled: true,
    emailFailure: false,
  };
  const emails: Array<{ recipient: string; key: string }> = [];
  const session = {
    id: `cs_test_${randomBytes(8).toString("hex")}`,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 50_000,
    currency: "usd",
    livemode: false,
    customer_details: { email: "buyer@example.test" },
    payment_link: "plink_test_existing",
    metadata: {},
  } as unknown as Stripe.Checkout.Session;
  const price = {
    id: "price_test_existing",
    livemode: false,
    unit_amount: 50_000,
    currency: "usd",
    type: "one_time",
  };
  const link = { url: ENTERPRISE_PAYMENT_LINK, livemode: false };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => structuredClone(session),
        listLineItems: async () => ({
          data: [{ quantity: 1, price }],
          has_more: false,
        }),
        update: async (
          _id: string,
          params: Stripe.Checkout.SessionUpdateParams,
        ) => {
          state.updates++;
          session.metadata = params.metadata as Stripe.Metadata;
          return session;
        },
      },
    },
    paymentLinks: { retrieve: async () => link },
  } as unknown as Stripe;
  let preimage = "";
  const merchant: SettlementProvider = {
    name: "coinos",
    isConfigured: () => true,
    createInvoice: async () => {
      state.invoices++;
      preimage = randomBytes(32).toString("hex");
      const hash = createHash("sha256")
        .update(Buffer.from(preimage, "hex"))
        .digest("hex");
      let timestamp = Math.floor(Date.now() / 1000);
      const words = Array<number>(7).fill(0);
      for (let i = 6; i >= 0; i--) {
        words[i] = timestamp % 32;
        timestamp = Math.floor(timestamp / 32);
      }
      return {
        invoice: bech32.encode(
          "lnbc1m",
          [
            ...words,
            1,
            1,
            20,
            ...bech32.toWords(Buffer.from(hash, "hex")),
            ...Array<number>(104).fill(0),
          ],
          4096,
        ),
        paymentHash: hash,
        provider: "coinos",
      };
    },
    verifyPayment: async () => ({ settledAt: 1, provider: "coinos" }),
  };
  const payer: NwcPayout = {
    configured: () => true,
    pay: async () => {
      state.pays++;
      return { status: "settled", preimage };
    },
    lookup: async () =>
      state.settled ? { status: "settled", preimage } : { status: "pending" },
  };
  const mint = new FiatMint({
    pool,
    merchant,
    payer,
    stripe: async () => ({ stripe, livemode: false }),
    priceId: () => price.id,
    origin: () => "https://example.test",
    secret: () => issuerSecret,
    allowTreasury: () => true,
    budgetSats: () => 200_000,
  });
  const fulfillment = new EnterpriseFulfillment({
    pool,
    mint,
    priceId: () => price.id,
    mailer: () => {
      const send = createEnterpriseMailer({
        apiKey: "synthetic-local-brevo-key",
        fetcher: async (_url, init) => {
          if (state.emailFailure)
            throw new Error("Synthetic ambiguous email submission");
          const email = JSON.parse(String(init!.body));
          assert.equal(email.sender.email, ENTERPRISE_SENDER);
          assert.equal(email.subject, ENTERPRISE_SUBJECT);
          assert.equal(
            email.textContent,
            enterpriseEmailBody(emails.at(-1)!.key),
          );
          return new Response(
            JSON.stringify({ messageId: "local-message-id" }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      });
      return async (recipient, key, deliveryId) => {
        emails.push({ recipient, key });
        return send(recipient, key, deliveryId);
      };
    },
  });
  return {
    pool,
    state,
    session,
    price,
    link,
    emails,
    fulfillment,
    invoke: () =>
      fulfillment.fulfill(session.id, "evt_test_existing", {
        stripe,
        livemode: false,
      }),
    cleanup: async () => {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

test("signed HTTP checkout triggers PostgreSQL + unchanged mint + mock Brevo exactly once", async () => {
  const f = await fixture();
  const app = express();
  registerFiatWebhook(
    app,
    async (body, signature) => {
      const event = verifyEnterpriseWebhook(body, signature, signingSecret);
      if (event) {
        assert.equal(event.data.object.id, f.session.id);
        await f.invoke();
      }
    },
    "/api/webhook/stripe",
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { body, signature } = signedEvent(
      "checkout.session.completed",
      undefined,
      f.session.id,
    );
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhook/stripe`;
    for (let replay = 0; replay < 2; replay++) {
      const response = await fetch(endpoint, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { received: true });
    }
    assert.equal(f.state.pays, 1);
    assert.equal(f.state.invoices, 1);
    assert.equal(f.emails.length, 1);
    const grant = inspectSubscriptionMacaroon(f.emails[0]!.key, issuerSecret)!;
    assert.equal(grant.scannerCredits, 100);
    assert.deepEqual(grant.allowedPaths, ["/api/scanner"]);
    assert.equal(f.emails[0]!.recipient, "buyer@example.test");
    const delivery = (
      await f.pool.query("SELECT * FROM stripe_enterprise_deliveries")
    ).rows[0];
    assert.equal(delivery.state, "sent");
    assert.equal(delivery.message_id, "local-message-id");
    assert.ok(enterpriseEmailBody(f.emails[0]!.key).includes(f.emails[0]!.key));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

test("unpaid, wrong amount/currency/mode/price/product never fund or email", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { payment_status: "unpaid" },
      { amount_total: 49_999 },
      { currency: "eur" },
      { livemode: true },
      { status: "open" },
      { mode: "subscription" },
    ]) {
      const original = structuredClone(f.session);
      Object.assign(f.session, patch);
      await f.invoke();
      Object.assign(f.session, original);
    }
    f.link.url = "https://buy.stripe.com/unrelated-product";
    await f.invoke();
    f.link.url = ENTERPRISE_PAYMENT_LINK;
    f.price.unit_amount = 100;
    await f.invoke();
    assert.equal(f.state.pays, 0);
    assert.equal(f.emails.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("pending funding retries reconcile without another payment or premature email", async () => {
  const f = await fixture();
  try {
    f.state.settled = false;
    await assert.rejects(f.invoke(), /not ready/);
    assert.equal(f.emails.length, 0);
    f.state.settled = true;
    await f.invoke();
    assert.equal(f.state.pays, 1);
    assert.equal(f.state.invoices, 1);
    assert.equal(f.emails.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("ambiguous email outcomes persist sending state and never resend or remint", async () => {
  const f = await fixture();
  try {
    f.state.emailFailure = true;
    await assert.rejects(f.invoke(), /ambiguous/);
    await assert.rejects(f.invoke(), /reconciliation/);
    assert.equal(f.emails.length, 1);
    assert.equal(f.state.pays, 1);
  } finally {
    await f.cleanup();
  }
});

test("parallel Stripe deliveries share durable locking and one funded credential", async () => {
  const f = await fixture();
  try {
    await Promise.allSettled([f.invoke(), f.invoke()]);
    await f.invoke();
    assert.equal(f.state.pays, 1);
    assert.equal(f.emails.length, 1);
  } finally {
    await f.cleanup();
  }
});
