import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { YieldWithdrawalInvoice } from "./yield-withdrawal-invoice";
import { createNwcPayout, type NwcPayout, type PayoutOutcome } from "./nwc-payout";
import { agentYieldMsats, assertAgentYield } from "./agent-yield-invariant";

export class YieldClaimError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export type PaidYieldReceipt = { paymentHash: string; provider: string; amountMsats: number; referralOwner?: string };
export type RoyaltyClaimSelection = { owner: string; paymentHashes: string[] };
export type YieldClaim = { claimId: string; totalMsats: bigint; receiptCount: number;
  paymentStatus: "pending" | "settled" | "failed"; txid?: string; preimage?: string; attempt?: number };
export interface PrivateYieldEarnings {
  claim(receipts: PaidYieldReceipt[], invoice: YieldWithdrawalInvoice, invoiceText: string,
    royalties?: RoyaltyClaimSelection): Promise<YieldClaim>;
  reconcile?(claimId: string): Promise<YieldClaim>;
}

/**
 * Reserve durably before paying; deduct only on proven settlement. SQL cannot
 * roll back Lightning, so uncertain outcomes retain durable exclusive reservations.
 */
export function createPrivateYieldEarnings(
  database = pool,
  now: () => number = Date.now,
  payouts: NwcPayout = createNwcPayout(),
): PrivateYieldEarnings {
  type ClaimRow = { id: string; total_msats: string; receipt_count: number; payment_status: "pending" | "settled" | "failed";
    invoice_payment_hash: string; invoice_digest: string; selection_digest: string;
    coinos_txid: string | null; preimage: string | null; attempt: number };
  const result = (row: ClaimRow): YieldClaim => ({
    claimId: row.id, totalMsats: BigInt(row.total_msats), receiptCount: row.receipt_count,
    paymentStatus: row.payment_status, ...(row.coinos_txid ? { txid: row.coinos_txid } : {}),
    attempt: row.attempt,
    ...(row.preimage ? { preimage: row.preimage } : {}),
  });
  async function finalize(claim: YieldClaim, outcome: PayoutOutcome): Promise<YieldClaim> {
    if (outcome.status === "pending") return claim;
    const client = await database.connect().catch(() => null);
    if (!client) return { ...claim, paymentStatus: "pending" };
    try {
      await client.query("BEGIN");
      const locked = await client.query<ClaimRow>("SELECT * FROM private_yield_claims WHERE id=$1 FOR UPDATE", [claim.claimId]);
      const row = locked.rows[0];
      if (!row) throw new Error("Missing payout claim");
      if (row.attempt !== claim.attempt) { await client.query("COMMIT"); return result(row); }
      if (row.payment_status !== "pending") { await client.query("COMMIT"); return result(row); }
      if (outcome.status === "failed") {
        await client.query("DELETE FROM private_yield_payout_items WHERE claim_id=$1", [claim.claimId]);
        await client.query("UPDATE private_yield_claims SET payment_status='failed',failure_code=$2 WHERE id=$1",
          [claim.claimId, outcome.code]);
      } else {
        const items = await client.query<{ source: string; payment_hash: string }>(
          "SELECT source,payment_hash FROM private_yield_payout_items WHERE claim_id=$1 ORDER BY source,payment_hash", [claim.claimId]);
        if (items.rows.length !== claim.receiptCount) throw new Error("Payout reservation mismatch");
        for (const [source, table] of [["yield", "private_yield_earnings"], ["royalty", "private_swarm_royalties"]]) {
          const hashes = items.rows.filter(item => item.source === source).map(item => item.payment_hash);
          if (!hashes.length) continue;
          const consumed = await client.query(
            `UPDATE ${table} SET balance_msats=0,claim_id=$2,claimed_at=$3
             WHERE payment_hash=ANY($1::text[]) AND claim_id IS NULL AND balance_msats>0 RETURNING payment_hash`,
            [hashes, claim.claimId, new Date(now())]);
          if (consumed.rowCount !== hashes.length) throw new Error("Incomplete settled payout consumption");
        }
        await client.query(
          "UPDATE private_yield_claims SET payment_status='settled',coinos_txid=$2,preimage=$3,failure_code=NULL WHERE id=$1",
          [claim.claimId, outcome.txid ?? null, outcome.preimage ?? null]);
      }
      await client.query("COMMIT");
      return { ...claim, paymentStatus: outcome.status, ...(outcome.status === "settled" ? outcome : {}) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // Payment might already have succeeded. Never release its reservation on
      // a local commit failure; an operator must reconcile using wallet evidence.
      return { ...claim, paymentStatus: "pending" };
    } finally { client.release(); }
  }
  return {
    async claim(receipts, invoice, invoiceText, royalties) {
      if (!payouts.configured()) throw new YieldClaimError(503, "NWC_PAYOUT_UNAVAILABLE");
      const hashes = receipts.map(receipt => receipt.paymentHash);
      const royaltyHashes = royalties?.paymentHashes ?? [];
      if (!hashes.length && !royaltyHashes.length || hashes.length + royaltyHashes.length > 32 ||
          new Set(hashes).size !== hashes.length || new Set(royaltyHashes).size !== royaltyHashes.length ||
          royaltyHashes.some(hash => !/^[0-9a-f]{64}$/.test(hash)) ||
          (royaltyHashes.length > 0 && !/^[0-9a-f]{64}$/.test(royalties?.owner ?? ""))) {
        throw new YieldClaimError(400, "DUPLICATE_OR_INVALID_RECEIPTS");
      }
      const ordered = [...receipts].sort((a, b) => a.paymentHash.localeCompare(b.paymentHash));
      const selectionDigest = createHash("sha256").update(JSON.stringify([
        ordered.map(receipt => [receipt.paymentHash, receipt.provider, receipt.amountMsats, receipt.referralOwner ?? null]),
        royalties ? { owner: royalties.owner, paymentHashes: [...royaltyHashes].sort() } : null,
      ])).digest("hex");
      const invoiceDigest = createHash("sha256").update(invoiceText).digest("hex");
      const client = await database.connect();
      let prepared: YieldClaim;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["payout-invoice:" + invoice.paymentHash]);
        const prior = await client.query<ClaimRow>(
          "SELECT * FROM private_yield_claims WHERE invoice_payment_hash=$1 FOR UPDATE", [invoice.paymentHash]);
        const existing = prior.rows[0];
        if (existing) {
          if (existing.selection_digest !== selectionDigest || existing.invoice_digest !== invoiceDigest ||
              existing.payment_status === "settled") throw new YieldClaimError(409, "WITHDRAWAL_INVOICE_ALREADY_USED");
          if (existing.payment_status === "pending") { await client.query("COMMIT"); return result(existing); }
        }
        let totalMsats = 0n;
        for (const receipt of ordered) {
          // Lock absent rows too, across all workers and all descendant macaroons.
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            ["private-yield:" + receipt.paymentHash]);
          const staked = await client.query(
            "SELECT 1 FROM yield_staking_receipts WHERE payment_hash=$1", [receipt.paymentHash]);
          if (staked.rows.length) throw new YieldClaimError(409, "YIELD_ALREADY_STAKED");
          const reserved = await client.query("SELECT claim_id FROM private_yield_payout_items WHERE source='yield' AND payment_hash=$1",
            [receipt.paymentHash]);
          if (reserved.rows.length) throw new YieldClaimError(409, "YIELD_RESERVED_OR_CLAIMED");
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
          const earned = agentYieldMsats(gross);
          assertAgentYield(gross, earned);
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
          if (balance) assertAgentYield(gross, BigInt(balance.earned_msats));
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
          const reserved = await client.query("SELECT claim_id FROM private_yield_payout_items WHERE source='royalty' AND payment_hash=$1",
            [paymentHash]);
          if (reserved.rows.length) throw new YieldClaimError(409, "ROYALTY_RESERVED_OR_CLAIMED");
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
        const claimId = existing?.id ?? randomUUID();
        await client.query(
          `INSERT INTO private_yield_claims
           (id,invoice_payment_hash,invoice_digest,total_msats,created_at,settlement_mode,payment_status,selection_digest,receipt_count)
           VALUES ($1,$2,$3,$4,$5,'mainnet','pending',$6,$7)
           ON CONFLICT (id) DO UPDATE SET payment_status='pending',failure_code=NULL,attempt=private_yield_claims.attempt+1`,
          [claimId, invoice.paymentHash, invoiceDigest, totalMsats.toString(), new Date(now()),
            selectionDigest, hashes.length + royaltyHashes.length],
        );
        for (const [source, selection] of [["yield", hashes], ["royalty", royaltyHashes]] as const) {
          for (const hash of selection) await client.query(
            "INSERT INTO private_yield_payout_items (source,payment_hash,claim_id) VALUES ($1,$2,$3)", [source, hash, claimId]);
        }
        await client.query("COMMIT");
        prepared = { claimId, totalMsats, receiptCount: hashes.length + royaltyHashes.length,
          paymentStatus: "pending", attempt: existing ? existing.attempt + 1 : 1 };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if ((error as { code?: string }).code === "23505") {
          throw new YieldClaimError(409, "WITHDRAWAL_INVOICE_ALREADY_USED");
        }
        throw error;
      } finally { client.release(); }
      let outcome: PayoutOutcome;
      try { outcome = await payouts.pay(invoiceText, invoice); }
      catch { outcome = { status: "pending" }; }
      const completed = await finalize(prepared!, outcome);
      if (completed.paymentStatus === "failed") throw new YieldClaimError(502, "NWC_PAYMENT_FAILED_BALANCES_RELEASED");
      return completed;
    },
    async reconcile(claimId) {
      if (!payouts.configured()) throw new YieldClaimError(503, "NWC_PAYOUT_UNAVAILABLE");
      const client = await database.connect();
      let row: ClaimRow | undefined;
      try {
        row = (await client.query<ClaimRow>(
          "SELECT * FROM private_yield_claims WHERE id=$1 AND settlement_mode='mainnet'", [claimId])).rows[0];
      } finally { client.release(); }
      if (!row) throw new YieldClaimError(404, "PAYOUT_NOT_FOUND");
      const claim = result(row);
      if (claim.paymentStatus !== "pending") return claim;
      return finalize(claim, await payouts.lookup({
        paymentHash: row.invoice_payment_hash, amountMsats: BigInt(row.total_msats),
        expiresAt: Number.MAX_SAFE_INTEGER,
      }));
    },
  };
}
