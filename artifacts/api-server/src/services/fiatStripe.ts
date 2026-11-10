// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import Stripe from "stripe";
import { runMigrations, StripeSync } from "stripe-replit-sync";
import { pinVerifiedSslMode } from "@workspace/db/connection-string";
import { logger } from "../lib/logger";
import { ReplitConnectors } from "@replit/connectors-sdk";

/** Official SDK over the managed connector; raw provider credentials never leave the proxy. */
export function createFiatStripeClient(): {
  stripe: Stripe;
  syncIdentity: string;
} {
  const key = process.env.STRIPE_SECRET_KEY;
  if (key) {
    if (!key.startsWith("sk_test_"))
      throw new Error("Fiat mint accepts Stripe test keys only");
    return {
      stripe: new Stripe(key, { timeout: 15_000, maxNetworkRetries: 1 }),
      syncIdentity: key,
    };
  }
  const connectors = new ReplitConnectors();
  // This is a local SDK identity, NOT a fake Stripe credential. Authorization is
  // removed below; the connected proxy authenticates the real Stripe requests.
  const syncIdentity = "replit-managed-fiat-mint-stripe";
  const stripe = new Stripe(syncIdentity, {
    timeout: 15_000,
    maxNetworkRetries: 1,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.stripe.com")
        throw new Error("Unexpected Stripe API host");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      delete headers.authorization;
      return connectors.proxy("stripe", url.pathname + url.search, {
        method: init?.method,
        headers,
        body: init?.body,
      });
    }),
  });
  return { stripe, syncIdentity };
}

export type FiatStripeRuntime = {
  stripe: Stripe;
  sync: StripeSync;
  webhookSecret: string;
};
let initialization: Promise<FiatStripeRuntime> | undefined;

function httpsOrigin(value: string | undefined): string {
  if (!value) throw new Error("FIAT_MINT_PUBLIC_ORIGIN required");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("FIAT_MINT_PUBLIC_ORIGIN must be an HTTPS origin");
  return url.origin;
}
export function fiatPublicOrigin(): string {
  return httpsOrigin(process.env.FIAT_MINT_PUBLIC_ORIGIN);
}

/** Lazy, fail-closed setup: missing Stripe configuration never stops existing L402. */
export function getFiatStripe(): Promise<FiatStripeRuntime> {
  initialization ??= (async () => {
    const { stripe, syncIdentity } = createFiatStripeClient();
    if ((await stripe.balance.retrieve()).livemode)
      throw new Error("Connected Stripe account must use test mode");
    const webhook = process.env.STRIPE_WEBHOOK_SECRET;
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("PostgreSQL required");
    const origin = httpsOrigin(process.env.FIAT_MINT_WEBHOOK_ORIGIN);
    await runMigrations({ databaseUrl: pinVerifiedSslMode(databaseUrl) });
    const sync = new StripeSync({
      poolConfig: { connectionString: pinVerifiedSslMode(databaseUrl) },
      stripeSecretKey: syncIdentity,
      stripeWebhookSecret: webhook,
      // Library exceptions can include Stripe request details: log fixed text only.
      logger: {
        info() {},
        warn() {
          logger.warn("Fiat Stripe synchronization warning");
        },
        error() {
          logger.error("Fiat Stripe synchronization failure");
        },
      },
    });
    // Public library extension point: all sync reads/writes use the same real SDK
    // transport, including connected credentials and rotated proxy identities.
    sync.stripe = stripe;
    try {
      let webhookSecret = webhook;
      if (!webhookSecret) {
        const url = `${origin}/api/stripe/webhook`;
        const managed = await sync.findOrCreateManagedWebhook(url);
        // Stripe only returns an endpoint's secret at creation. The sync
        // library's durable managed record retains it across later restarts.
        webhookSecret =
          managed.secret ?? (await sync.getManagedWebhookByUrl(url))?.secret;
      }
      if (!webhookSecret)
        throw new Error("STRIPE_WEBHOOK_SECRET required for existing webhook");
      await sync.syncBackfill({ object: "all" });
      return { stripe, sync, webhookSecret };
    } catch (error) {
      await sync.postgresClient.pool.end();
      throw error;
    }
  })().catch((error) => {
    initialization = undefined;
    // Do not log Stripe SDK errors: they can contain request/credential data.
    logger.warn(
      "Fiat mint Stripe initialization unavailable; check server configuration",
    );
    throw error;
  });
  return initialization;
}
