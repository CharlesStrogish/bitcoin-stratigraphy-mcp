import { getFiatStripeClient } from "./fiat-stripe-client";

const stripe = getFiatStripeClient();
const products = await stripe.products.search({
  query: "metadata['fiat_mint_product']:'scanner-100-v1' AND active:'true'",
});
const product =
  products.data[0] ??
  (await stripe.products.create(
    {
      name: "Enterprise API Block",
      description:
        "100 prepaid Article 12 heuristic scanner calls, 30-day validity. Test purchase only.",
      metadata: { fiat_mint_product: "scanner-100-v1" },
    },
    { idempotencyKey: "fiat-mint-product-scanner-100-v1" },
  ));
const prices = await stripe.prices.list({ product: product.id, active: true });
const price =
  prices.data.find(
    (p) =>
      p.currency === "usd" && p.unit_amount === 50_000 && p.type === "one_time",
  ) ??
  (await stripe.prices.create(
    { product: product.id, currency: "usd", unit_amount: 50_000 },
    { idempotencyKey: "fiat-mint-price-scanner-100-usd500-v1" },
  ));
console.log(
  `Set FIAT_MINT_STRIPE_PRICE_ID=${price.id}. No payment or treasury call was made.`,
);
