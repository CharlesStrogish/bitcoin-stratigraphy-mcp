// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
// Additive checkout protection: never retries, cancels a purchase, or sends funds.
import Stripe from "stripe";

export const FIAT_GATEWAY_DEADLINE_MS = 5_000;

export class FiatGatewayTimeout extends Error {
  constructor() {
    super("Fiat gateway deadline exceeded");
    this.name = "FiatGatewayTimeout";
  }
}

/** Only upstream availability failures qualify; validation/auth/DB errors fail closed. */
export function isFiatGatewayOffline(error: unknown): boolean {
  if (error instanceof FiatGatewayTimeout) return true;
  if (!(error instanceof Stripe.errors.StripeError)) return false;
  if (error.statusCode && error.statusCode >= 500 && error.statusCode <= 599)
    return true;
  return error instanceof Stripe.errors.StripeConnectionError &&
    (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT" ||
      /timed? ?out/i.test(error.message));
}

/**
 * Checkout creation cannot charge a card. A late Stripe session remains owned
 * by the original HttpOnly cookie and idempotency key for status recovery.
 * Observe both outcomes; do not retry an uncertain creation or affect fulfillment.
 */
export async function withFiatGatewayDeadline<T>(
  primary: () => Promise<T>,
  timeoutMs = FIAT_GATEWAY_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(primary),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FiatGatewayTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
