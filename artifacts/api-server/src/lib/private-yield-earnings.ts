import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { YieldWithdrawalInvoice } from "./yield-withdrawal-invoice";

export class YieldClaimError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export type PaidYieldReceipt = { paymentHash: string; provider: string; amountMsats: number };
export type YieldClaim = { claimId: string; totalMsats: bigint; receiptCount: number };
export interface PrivateYieldEarnings {
  claim(receipts: PaidYieldReceipt[], invoice: YieldWithdrawalInvoice, invoiceText: string): Promise<YieldClaim>;
}

/**
 * Private SIMULATION balances only. Accrual requires an existing confirmed L402
 * revenue record; neither unpaid invoices nor the public outgoing-payout feed
 * are earnings sources. No existing Treasury allocation is modified.
 */
export function createPrivateYieldEarnings(
  database = pool,
  now: () => number = Date.now,
): PrivateYieldEarnings {
  return {
    async claim(receipts, invoice, invoiceText) {
      const hashes = receipts.map(receipt => receipt.paymentHash);
      if (!hashes.length || hashes.length > 32 || new Set(hashes).size !== hashes.length) {
        throw new YieldClaimError(400, "DUPLICATE_OR_INVALID_RECEIPTS");
      }
      const ordered = [...receipts].sort((a, b) => a.paymentHash.localeCompare(b.paymentHash));
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        let totalMsats = 0n;
        for (const receipt of ordered) {
          // Lock absent rows too, across all workers and all descendant macaroons.
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            ["private-yield:" + receipt.paymentHash]);
          const paid = await client.query<{ sats: string }>(
            "SELECT sats_received::text AS sats FROM revenue_ledger WHERE payment_hash=$1 AND channel='L402' FOR SHARE",
            [receipt.paymentHash],
          );
          if (!paid.rows[0]) throw new YieldClaimError(404, "PAID_RECEIPT_NOT_FOUND");
          const gross = BigInt(paid.rows[0].sats) * 1000n;
          if (!Number.isSafeInteger(receipt.amountMsats) || receipt.amountMsats <= 0 ||
              gross !== BigInt(receipt.amountMsats)) {
            throw new YieldClaimError(403, "RECEIPT_AMOUNT_MISMATCH");
          }
          const earned = gross * 21n / 100n;
          await client.query(
            `INSERT INTO private_yield_earnings
             (payment_hash, provider, gross_msats, earned_msats, balance_msats)
             VALUES ($1,$2,$3,$4,$4) ON CONFLICT (payment_hash) DO NOTHING`,
            [receipt.paymentHash, receipt.provider, gross.toString(), earned.toString()],
          );
          const record = await client.query<{
            provider: string; gross_msats: string; earned_msats: string;
            balance_msats: string; claim_id: string | null;
          }>("SELECT * FROM private_yield_earnings WHERE payment_hash=$1 FOR UPDATE", [receipt.paymentHash]);
          const balance = record.rows[0];
          if (!balance || balance.provider !== receipt.provider ||
              BigInt(balance.gross_msats) !== gross || BigInt(balance.earned_msats) !== earned) {
            throw new YieldClaimError(403, "EARNINGS_BINDING_MISMATCH");
          }
          if (balance.claim_id || BigInt(balance.balance_msats) === 0n) {
            throw new YieldClaimError(409, "YIELD_ALREADY_CLAIMED");
          }
          if (BigInt(balance.balance_msats) !== earned) throw new Error("Invalid private earnings balance");
          totalMsats += earned;
        }
        if (totalMsats > BigInt(Number.MAX_SAFE_INTEGER) || invoice.amountMsats !== totalMsats) {
          throw new YieldClaimError(400, "INVOICE_AMOUNT_MISMATCH");
        }
        if (invoice.expiresAt <= now()) throw new YieldClaimError(400, "INVOICE_EXPIRED");
        const claimId = randomUUID();
        await client.query(
          `INSERT INTO private_yield_claims
           (id, invoice_payment_hash, invoice_digest, total_msats, created_at) VALUES ($1,$2,$3,$4,$5)`,
          [claimId, invoice.paymentHash, createHash("sha256").update(invoiceText).digest("hex"),
            totalMsats.toString(), new Date(now())],
        );
        const consumed = await client.query(
          `UPDATE private_yield_earnings SET balance_msats=0, claim_id=$2, claimed_at=$3
           WHERE payment_hash=ANY($1::text[]) AND claim_id IS NULL AND balance_msats>0 RETURNING payment_hash`,
          [hashes, claimId, new Date(now())],
        );
        if (consumed.rowCount !== hashes.length) throw new Error("Incomplete atomic yield consumption");
        await client.query("COMMIT");
        return { claimId, totalMsats, receiptCount: hashes.length };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if ((error as { code?: string }).code === "23505") {
          throw new YieldClaimError(409, "WITHDRAWAL_INVOICE_ALREADY_USED");
        }
        throw error;
      } finally { client.release(); }
    },
  };
}
