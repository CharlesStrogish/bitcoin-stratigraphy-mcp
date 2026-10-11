// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { getEscrowToll, type EscrowTollQuote } from "@workspace/api-client-react";

export function fallbackEscrowToll(): EscrowTollQuote {
  return {
    toll_fee_sats: 21, target_usd: 0.02, btc_usd_price: null,
    source: "fallback", quoted_at: new Date().toISOString(),
  };
}

/** A failed quote must not prevent a browser-only simulation or reuse a stale fee. */
export async function evaluateEscrowToll(
  signal: AbortSignal,
  readQuote: typeof getEscrowToll = getEscrowToll,
): Promise<EscrowTollQuote> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 7_000);
  try {
    const quote = await readQuote({ signal: controller.signal, cache: "no-store" });
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const fee = quote?.toll_fee_sats;
    if (!Number.isSafeInteger(fee) || fee < 1 || quote.target_usd !== 0.02
        || !["market", "fallback"].includes(quote.source)
        || (quote.source === "fallback" && fee !== 21)) return fallbackEscrowToll();
    return quote;
  } catch (error) {
    if (signal.aborted) throw error;
    return fallbackEscrowToll();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
