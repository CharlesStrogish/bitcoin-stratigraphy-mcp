// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { getFiatStripe } from "./fiatStripe";
import { fiatMint } from "./fiatMintRuntime";

export class FiatWebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string) {
    if (!Buffer.isBuffer(payload)) throw new Error("Raw webhook body required");
    const runtime = await getFiatStripe();
    // Exact raw bytes, timestamp tolerance and endpoint secret verified by the official SDK.
    const event = runtime.stripe.webhooks.constructEvent(
      payload,
      signature,
      runtime.webhookSecret,
    );
    if (event.livemode) throw new Error("Live Stripe events are not supported");
    await runtime.sync.processWebhook(payload, signature);
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await fiatMint.acceptSession(event.data.object.id);
      // Worker recovers durably queued orders across process restarts.
    }
  }
}
