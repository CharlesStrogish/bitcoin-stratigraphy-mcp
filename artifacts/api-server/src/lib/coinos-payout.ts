import { createHash } from "node:crypto";
import type { YieldWithdrawalInvoice } from "./yield-withdrawal-invoice";

export type PayoutOutcome =
  | { status: "settled"; txid?: string; preimage?: string }
  | { status: "failed"; code: string }
  | { status: "pending" };
export interface CoinosPayout {
  configured(): boolean;
  pay(invoiceText: string, invoice: YieldWithdrawalInvoice): Promise<PayoutOutcome>;
  lookup(invoice: YieldWithdrawalInvoice): Promise<PayoutOutcome>;
}

/** No retries on POST. A transport failure can happen AFTER funds were sent. */
export function createCoinosPayout(options: {
  token?: () => string | undefined; fetch?: typeof fetch; timeoutMs?: number;
} = {}): CoinosPayout {
  const token = options.token ?? (() => process.env.COINOS_API_TOKEN);
  const transport = options.fetch ?? fetch;
  const configured = () => Boolean(token()) && (process.env.NODE_ENV !== "test" || !!options.fetch);
  const pending: PayoutOutcome = { status: "pending" };
  function evidence(value: unknown, invoice: YieldWithdrawalInvoice, requireOutgoing = false): PayoutOutcome {
    if (!value || typeof value !== "object") return pending;
    const row = value as Record<string, unknown>;
    const preimage = [row.preimage, row.payment_preimage, row.ref].find(value =>
      typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)) as string | undefined;
    const txid = [row.uid, row.id, row.txid].find(value =>
      typeof value === "string" && value.length > 0 && value.length <= 256) as string | undefined;
    const amount = typeof row.amount === "number" && row.amount < 0
      ? /^([0-9]+)(?:\.([0-9]{1,3}))?$/.exec(String(-row.amount)) : null;
    const outgoing = amount &&
      BigInt(amount[1]!) * 1000n + BigInt((amount[2] ?? "").padEnd(3, "0")) === invoice.amountMsats;
    if (requireOutgoing && !outgoing) return pending;
    if (preimage && createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") === invoice.paymentHash) {
      return { status: "settled", preimage: preimage.toLowerCase(), ...(txid ? { txid } : {}) };
    }
    // Provider-authenticated outgoing records without a preimage need exact
    // invoice/amount binding AND an explicit terminal status, not merely HTTP 200.
    const hash = row.payment_hash ?? row.hash;
    if (hash !== invoice.paymentHash || !outgoing || !txid || row.pending === true) return pending;
    if (["settled", "complete", "completed", "succeeded"].includes(String(row.status))) return { status: "settled", txid };
    // A failed history row can belong to an older attempt of this same invoice.
    // Without an exact provider attempt binding it cannot unlock the current one.
    if (row.status === "failed" && !requireOutgoing) return { status: "failed", code: "COINOS_PAYMENT_FAILED" };
    return pending;
  }
  async function request(path: string, method: string, body?: unknown) {
    if (!configured()) throw new Error("Coinos REST payout credentials or test transport unavailable");
    return transport(`https://coinos.io/api${path}`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  }
  return {
    configured,
    async pay(invoiceText, invoice) {
      try {
        const response = await request("/payments", "POST", { payreq: invoiceText });
        // Request validation/auth rejections are definitive non-payments. A 5xx,
        // 408, malformed body, or "routing error" of uncertain finality is NOT.
        if ([401, 403].includes(response.status)) {
          return { status: "failed", code: "COINOS_REQUEST_REJECTED" };
        }
        if ([400, 422].includes(response.status)) {
          const body = await response.json().catch(() => null) as Record<string, unknown> | string | null;
          const error = typeof body === "string" ? body : body?.error ?? body?.message;
          if (typeof error === "string" &&
              /^(insufficient (funds|balance)|invalid (bolt11 )?invoice|invoice (has )?expired|no route|route not found|payment failed)[.!]?$/i.test(error.trim())) {
            return { status: "failed", code: "COINOS_PAYMENT_REJECTED" };
          }
          return pending;
        }
        if (!response.ok) return pending;
        return evidence(await response.json(), invoice);
      } catch { return pending; }
    },
    async lookup(invoice) {
      try {
        // Bounded history scan. Not finding the invoice is inconclusive; never
        // re-send a pending payment or unlock it on a partial/empty history page.
        for (let offset = 0; offset < 1000; offset += 100) {
          const response = await request(`/payments?limit=100&offset=${offset}`, "GET");
          if (!response.ok) return pending;
          const value = await response.json() as { payments?: unknown[] } | unknown[];
          const rows = Array.isArray(value) ? value : value?.payments;
          if (!Array.isArray(rows)) return pending;
          for (const row of rows) {
            const result = evidence(row, invoice, true);
            if (result.status !== "pending") return result;
          }
          if (rows.length < 100) return pending;
        }
      } catch { /* Unknown remains reserved, including history outages. */ }
      return pending;
    },
  };
}
