// Same credential convention as the API; scripts must never import artifact code.
import Stripe from "stripe";
export function getFiatStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key?.startsWith("sk_test_"))
    throw new Error("STRIPE_SECRET_KEY must be a Stripe test key");
  return new Stripe(key, { timeout: 15_000, maxNetworkRetries: 1 });
}
