// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash } from "node:crypto";
import { mcpToolPrices } from "./mcp-pricing";

export type PublicYieldProof = {
  timestamp: string;
  tool_executed: string;
  sats_yield_paid: number;
  cryptographic_receipt: {
    scheme: "sha256-yield-record-v1";
    gross_invoice_msats: string;
    yield_paid_msats: string;
    allocation_percent: 21;
    digest: string;
  };
};

type ConfirmedYieldPayout = {
  timestamp: string;
  toolExecuted: string;
  grossInvoiceMsats: bigint;
  yieldPaidMsats: bigint;
  confirmedPayout: true;
};

const MAX_RECORDS = 256;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * Process-local scaffold only: current enterprise invoices record allocations,
 * not outgoing payouts. No payment gate is connected to this writer.
 *
 * A future trusted settlement adapter may append only after the entire 21% pool
 * was actually disbursed. Never call this with a settled incoming invoice or a
 * merely credited allocation. This is not a payout verifier or durable archive.
 */
export function createPublicYieldLedger(now: () => number = Date.now) {
  const records = new Map<string, PublicYieldProof>();

  function prune() {
    const cutoff = now() - RETENTION_MS;
    for (const [digest, record] of records) {
      if (Date.parse(record.timestamp) < cutoff) records.delete(digest);
    }
  }

  return {
    appendConfirmedPayout(input: ConfirmedYieldPayout): PublicYieldProof {
      const timestampMs = Date.parse(input.timestamp);
      if (
        input.confirmedPayout !== true ||
        !Number.isFinite(timestampMs) ||
        new Date(timestampMs).toISOString() !== input.timestamp ||
        timestampMs > now() ||
        timestampMs < now() - RETENTION_MS ||
        !Object.hasOwn(mcpToolPrices, input.toolExecuted) ||
        mcpToolPrices[input.toolExecuted as keyof typeof mcpToolPrices] <= 0 ||
        typeof input.grossInvoiceMsats !== "bigint" ||
        typeof input.yieldPaidMsats !== "bigint" ||
        input.grossInvoiceMsats <= 0n ||
        input.grossInvoiceMsats > BigInt(Number.MAX_SAFE_INTEGER) ||
        input.yieldPaidMsats <= 0n ||
        input.yieldPaidMsats !== (input.grossInvoiceMsats * 21n) / 100n
      ) {
        throw new Error("Invalid confirmed aggregate yield payout");
      }
      const gross = input.grossInvoiceMsats.toString();
      const paid = input.yieldPaidMsats.toString();
      // Public preimage: JSON array [timestamp, tool, gross_msats, paid_msats, 21].
      // No Lightning preimage, macaroon, address, identity or invoice hash enters it.
      const digest = createHash("sha256")
        .update(JSON.stringify([input.timestamp, input.toolExecuted, gross, paid, 21]))
        .digest("hex");
      const record: PublicYieldProof = {
        timestamp: input.timestamp,
        tool_executed: input.toolExecuted,
        sats_yield_paid: Number(input.yieldPaidMsats) / 1_000,
        cryptographic_receipt: {
          scheme: "sha256-yield-record-v1",
          gross_invoice_msats: gross,
          yield_paid_msats: paid,
          allocation_percent: 21,
          digest,
        },
      };
      prune();
      records.set(digest, record);
      const newest = [...records.values()].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
      );
      for (const expired of newest.slice(MAX_RECORDS)) {
        records.delete(expired.cryptographic_receipt.digest);
      }
      return structuredClone(record);
    },
    snapshot(): PublicYieldProof[] {
      prune();
      return structuredClone(
        [...records.values()].sort(
          (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
        ),
      );
    },
  };
}

export const publicYieldLedger = createPublicYieldLedger();
