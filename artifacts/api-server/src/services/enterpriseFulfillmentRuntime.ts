// Copyright (c) 2026 Charles R. Strogish. AGPL-3.0-only / Commercial.
import { pool } from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { EnterpriseFulfillment } from "./enterpriseFulfillment";
import { createEnterpriseMailer } from "./enterpriseEmail";
import { fiatMint } from "./fiatMintRuntime";
import { getFiatStripe, type FiatStripeRuntime } from "./fiatStripe";
import { verifyEnterpriseWebhook } from "./enterpriseWebhook";

const fulfillment = new EnterpriseFulfillment({
  pool,
  mint: fiatMint,
  priceId: () => process.env.FIAT_MINT_STRIPE_PRICE_ID,
  mailer: () => {
    if (process.env.BREVO_API_KEY)
      return createEnterpriseMailer({ apiKey: process.env.BREVO_API_KEY });
    const connectors = new ReplitConnectors();
    return createEnterpriseMailer({
      proxy: (path, options) => connectors.proxy("brevo", path, options),
    });
  },
});

export async function fulfillEnterpriseEvent(
  payload: Buffer,
  signature: string,
  providedRuntime?: FiatStripeRuntime,
) {
  const event = verifyEnterpriseWebhook(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET,
  );
  if (!event) return;
  const runtime = providedRuntime ?? (await getFiatStripe());
  if (
    event.livemode !== runtime.livemode ||
    event.data.object.livemode !== runtime.livemode
  )
    throw new Error("Stripe account mode mismatch");
  // Existing endpoint already synchronized this exact signed event.
  if (!providedRuntime) await runtime.sync.processWebhook(payload, signature);
  await fulfillment.fulfill(event.data.object.id, event.id, runtime);
}
