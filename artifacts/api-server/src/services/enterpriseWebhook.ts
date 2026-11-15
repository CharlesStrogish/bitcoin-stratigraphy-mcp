// Copyright (c) 2026 Charles R. Strogish. AGPL-3.0-only / Commercial.
import Stripe from "stripe";

/** Verify raw bytes and the SDK's timestamp tolerance BEFORE any provider or DB I/O. */
export function verifyEnterpriseWebhook(
  payload: Buffer,
  signature: string,
  secret: string | undefined,
): Stripe.CheckoutSessionCompletedEvent | null {
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required");
  if (!Buffer.isBuffer(payload)) throw new Error("Raw webhook body required");
  const event = Stripe.webhooks.constructEvent(payload, signature, secret);
  return event.type === "checkout.session.completed" ? event : null;
}
