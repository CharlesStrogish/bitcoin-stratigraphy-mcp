import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { YieldWithdrawalInvoice } from "./yield-withdrawal-invoice";

export class YieldClaimError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export type PaidYieldReceipt = { paymentHash: string; provider: string; amountMsats: number; referralOwner?: string };
export type RoyaltyClaimSelection = { owner: string; paymentHashes: string[] };
export type YieldClaim = { claimId: string; totalMsats: bigint; receiptCount: number };
export interface PrivateYieldEarnings {
  claim(receipts: PaidYieldReceipt[], invoice: YieldWithdrawalInvoice, invoiceText: string,
    royalties?: RoyaltyClaimSelection): Promise<YieldClaim>;
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
    async claim(receipts, invoice, invoiceText, royalties) {
      const hashes = receipts.map(receipt => receipt.paymentHash);
      const royaltyHashes = royalties?.paymentHashes ?? [];
      if (!hashes.length && !royaltyHashes.length || hashes.length + royaltyHashes.length > 32 ||
          new Set(hashes).size !== hashes.length || new Set(royaltyHashes).size !== royaltyHashes.length ||
          royaltyHashes.some(hash => !/^[0-9a-f]{64}$/.test(hash)) ||
          (royaltyHashes.length > 0 && !/^[0-9a-f]{64}$/.test(royalties?.owner ?? ""))) {
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
          let gross = BigInt(paid.rows[0].sats) * 1000n;
          if (receipt.referralOwner) {
            // Legacy revenue totals use whole sats; the signed referred invoice
            // and its separately persisted settlement retain exact millisatoshis.
            const exact = await client.query<{ gross_msats: string }>(
              `SELECT gross_msats::text FROM private_swarm_royalties
               WHERE payment_hash=$1 AND owner=$2 AND provider=$3 FOR SHARE`,
              [receipt.paymentHash, receipt.referralOwner, receipt.provider]);
            if (!exact.rows[0] || (BigInt(exact.rows[0].gross_msats) + 999n) / 1000n !== BigInt(paid.rows[0].sats)) {
              throw new YieldClaimError(403, "REFERRAL_SETTLEMENT_MISMATCH");
            }
            gross = BigInt(exact.rows[0].gross_msats);
          }
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
        for (const paymentHash of [...royaltyHashes].sort()) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            ["private-royalty:" + paymentHash]);
          const result = await client.query<{
            owner: string; balance_msats: string; earned_msats: string; gross_msats: string; claim_id: string | null;
          }>("SELECT * FROM private_swarm_royalties WHERE payment_hash=$1 FOR UPDATE", [paymentHash]);
          const record = result.rows[0];
          if (!record || record.owner !== royalties!.owner) throw new YieldClaimError(403, "ROYALTY_OWNER_MISMATCH");
          if (record.claim_id || BigInt(record.balance_msats) === 0n) throw new YieldClaimError(409, "YIELD_ALREADY_CLAIMED");
          const earned = BigInt(record.gross_msats) * 5n / 100n;
          if (BigInt(record.earned_msats) !== earned || BigInt(record.balance_msats) !== earned) {
            throw new YieldClaimError(403, "ROYALTY_BINDING_MISMATCH");
          }
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
        if (royaltyHashes.length) {
          const consumedRoyalties = await client.query(
            `UPDATE private_swarm_royalties SET balance_msats=0,claim_id=$2,claimed_at=$3
             WHERE payment_hash=ANY($1::text[]) AND owner=$4 AND claim_id IS NULL AND balance_msats>0 RETURNING payment_hash`,
            [royaltyHashes, claimId, new Date(now()), royalties!.owner]);
          if (consumedRoyalties.rowCount !== royaltyHashes.length) throw new Error("Incomplete atomic royalty consumption");
        }
        await client.query("COMMIT");
        return { claimId, totalMsats, receiptCount: hashes.length + royaltyHashes.length };
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
