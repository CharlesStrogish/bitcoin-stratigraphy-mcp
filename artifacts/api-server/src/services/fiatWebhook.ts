// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { getFiatStripe, type FiatStripeRuntime } from "./fiatStripe";
import { fiatMint } from "./fiatMintRuntime";

export async function processFiatWebhook(
  payload: Buffer,
  signature: string,
  runtime: Pick<FiatStripeRuntime, "stripe" | "webhookSecret" | "livemode"> & {
    sync: {
      processWebhook: (payload: Buffer, signature: string) => Promise<unknown>;
    };
  },
  acceptSession: (sessionId: string) => Promise<void>,
) {
  if (!Buffer.isBuffer(payload)) throw new Error("Raw webhook body required");
  // Exact raw bytes, timestamp tolerance and endpoint secret verified by the official SDK.
  const event = runtime.stripe.webhooks.constructEvent(
    payload,
    signature,
    runtime.webhookSecret,
  );
  if (event.livemode !== runtime.livemode)
    throw new Error("Stripe event mode does not match configured account");
  const checkoutEvent =
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded";
  if (checkoutEvent && event.data.object.livemode !== runtime.livemode)
    throw new Error("Stripe session mode does not match configured account");
  await runtime.sync.processWebhook(payload, signature);
  if (checkoutEvent) {
    await acceptSession(event.data.object.id);
  }
}

export class FiatWebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string) {
    const runtime = await getFiatStripe();
    await processFiatWebhook(payload, signature, runtime, (id) =>
      fiatMint.acceptSession(id),
    );
  }
}
