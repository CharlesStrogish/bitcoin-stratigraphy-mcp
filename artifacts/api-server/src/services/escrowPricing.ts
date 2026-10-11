// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { readLiveBitcoinUsdPrice } from "./stratigraphy-stream";

export const ESCROW_TARGET_USD = 0.02;
export const ESCROW_FALLBACK_TOLL = 21;

function usablePrice(price: unknown): price is number {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return false;
  const raw = (ESCROW_TARGET_USD / price) * 100_000_000;
  return Number.isFinite(raw) && raw <= Number.MAX_SAFE_INTEGER;
}

/** Match Python round(): nearest integer, ties to even, with a one-sat floor. */
export function calculateEscrowToll(price: unknown): number {
  if (!usablePrice(price)) return ESCROW_FALLBACK_TOLL;
  const raw = (ESCROW_TARGET_USD / price) * 100_000_000;
  const lower = Math.floor(raw);
  const rounded = raw - lower === 0.5 ? lower + (lower % 2) : Math.round(raw);
  return Math.max(1, rounded);
}

/** Share in-flight reads; failures replace expired quotes rather than reuse them. */
export function createEscrowPriceReader(
  readPrice = readLiveBitcoinUsdPrice,
  now: () => number = Date.now,
) {
  let cached: number | null = null;
  let expiresAt = 0;
  let pending: Promise<number | null> | undefined;
  return (): Promise<number | null> => {
    if (now() < expiresAt) return Promise.resolve(cached);
    if (pending) return pending;
    pending = Promise.resolve()
      .then(readPrice)
      .then((price) => usablePrice(price) ? price : null)
      .catch(() => null)
      .then((price) => {
        cached = price;
        expiresAt = now() + (price === null ? 2_000 : 15_000);
        return price;
      })
      .finally(() => { pending = undefined; });
    return pending;
  };
}

export const readEscrowBitcoinPrice = createEscrowPriceReader();

export function escrowTollQuote(price: unknown) {
  const valid = usablePrice(price);
  return {
    toll_fee_sats: calculateEscrowToll(price),
    target_usd: ESCROW_TARGET_USD,
    btc_usd_price: valid ? price : null,
    source: valid ? "market" as const : "fallback" as const,
    quoted_at: new Date().toISOString(),
  };
}
