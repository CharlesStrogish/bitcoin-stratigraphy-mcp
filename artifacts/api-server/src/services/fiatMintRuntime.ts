// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { pool } from "@workspace/db";
import { FiatMint } from "./fiatMint";
import { createCoinosSettlementProvider } from "./settlement/coinos";
import { createNwcPayout } from "../lib/nwc-payout";
import { getFiatStripe, fiatPublicOrigin } from "./fiatStripe";
import { logger } from "../lib/logger";
import { fiatTreasuryPolicy } from "./fiatStripeMode";

export const fiatMint = new FiatMint({
  pool,
  merchant: createCoinosSettlementProvider(),
  // A separately budgeted payer must never draw from the existing staking treasury.
  payer: createNwcPayout({ uri: () => process.env.FIAT_MINT_PAYER_NWC_URI }),
  stripe: async () => {
    const { stripe, livemode } = await getFiatStripe();
    return { stripe, livemode };
  },
  priceId: () => process.env.FIAT_MINT_STRIPE_PRICE_ID,
  origin: fiatPublicOrigin,
  secret: () => process.env.SESSION_SECRET,
  // Historical test authorization never grants permission for live spending.
  allowTreasury: (livemode) =>
    fiatTreasuryPolicy(livemode, process.env).allowed,
  budgetSats: (livemode) =>
    fiatTreasuryPolicy(livemode, process.env).budgetSats,
});

export function startFiatMintWorker() {
  if (
    process.env.FIAT_MINT_ALLOW_TEST_TREASURY !== "true" &&
    process.env.FIAT_MINT_ALLOW_TREASURY !== "true"
  )
    return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fiatMint.drain();
    } catch {
      logger.warn(
        "Fiat fulfillment needs reconciliation; no automatic re-payment",
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
