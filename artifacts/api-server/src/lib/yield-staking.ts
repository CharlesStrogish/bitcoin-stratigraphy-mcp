import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { agentYieldMsats, assertAgentYield } from "./agent-yield-invariant";

export class YieldStakingError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export type StakingReceipt = {
  pubkey: string; paymentHash: string; provider: string; amountMsats: number;
};
export type YieldEscrow = {
  pubkey: string; staked_sats: number; vip_status: boolean; unlocked_features: string[];
};
export interface YieldStaking {
  credit(receipt: StakingReceipt): Promise<void>;
  get(pubkey: string): Promise<YieldEscrow>;
}
const hex = /^[0-9a-f]{64}$/;
const pubkeyHash = (pubkey: string) => {
  if (!hex.test(pubkey)) throw new YieldStakingError(400, "INVALID_STAKING_PUBKEY");
  return createHash("sha256").update(Buffer.from(pubkey, "hex")).digest("hex");
};

/**
 * The advisory lock is deliberately identical to Treasury's receipt lock.
 * A stake and an explicit withdrawal cannot both reserve the same payment,
 * even across processes or while an outgoing wallet call is still pending.
 */
export function createYieldStaking(database = pool): YieldStaking {
  return {
    async credit(receipt) {
      const owner = pubkeyHash(receipt.pubkey);
      if (!hex.test(receipt.paymentHash) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(receipt.provider) ||
          !Number.isSafeInteger(receipt.amountMsats) || receipt.amountMsats <= 0) {
        throw new YieldStakingError(400, "INVALID_STAKING_RECEIPT");
      }
      const gross = BigInt(receipt.amountMsats);
      const earned = agentYieldMsats(gross);
      assertAgentYield(gross, earned);
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["private-yield:" + receipt.paymentHash]);
        const existing = await client.query<{
          pubkey_hash: string; provider: string; gross_msats: string; earned_msats: string;
        }>("SELECT * FROM yield_staking_receipts WHERE payment_hash=$1", [receipt.paymentHash]);
        const prior = existing.rows[0];
        if (prior) {
          assertAgentYield(gross, BigInt(prior.earned_msats));
          if (prior.pubkey_hash !== owner || prior.provider !== receipt.provider ||
              BigInt(prior.gross_msats) !== gross || BigInt(prior.earned_msats) !== earned) {
            throw new YieldStakingError(409, "STAKING_RECEIPT_BINDING_MISMATCH");
          }
          await client.query("COMMIT");
          return;
        }
        const reserved = await client.query(
          "SELECT 1 FROM private_yield_payout_items WHERE source='yield' AND payment_hash=$1",
          [receipt.paymentHash]);
        const consumed = await client.query(
          "SELECT 1 FROM private_yield_earnings WHERE payment_hash=$1 AND (claim_id IS NOT NULL OR balance_msats=0)",
          [receipt.paymentHash]);
        if (reserved.rows.length || consumed.rows.length) {
          throw new YieldStakingError(409, "YIELD_RESERVED_OR_CLAIMED");
        }
        // Only the settlement-verifying middleware can provide the exact msat
        // receipt. Independently require durable evidence of incoming revenue.
        const paid = await client.query<{ sats: string }>(
          "SELECT sats_received::text AS sats FROM revenue_ledger WHERE payment_hash=$1 AND channel='L402' FOR SHARE",
          [receipt.paymentHash]);
        if (!paid.rows[0] || BigInt(paid.rows[0].sats) !== (gross + 999n) / 1000n) {
          throw new YieldStakingError(403, "STAKING_SETTLEMENT_MISMATCH");
        }
        await client.query(
          `INSERT INTO yield_staking_accounts (pubkey_hash,staked_msats) VALUES ($1,$2)
           ON CONFLICT (pubkey_hash) DO UPDATE
           SET staked_msats=yield_staking_accounts.staked_msats+EXCLUDED.staked_msats`,
          [owner, earned.toString()]);
        await client.query(
          `INSERT INTO yield_staking_receipts (payment_hash,pubkey_hash,provider,gross_msats,earned_msats)
           VALUES ($1,$2,$3,$4,$5)`,
          [receipt.paymentHash, owner, receipt.provider, gross.toString(), earned.toString()]);
        assertAgentYield(gross, earned);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async get(pubkey) {
      const owner = pubkeyHash(pubkey);
      const client = await database.connect();
      try {
        const result = await client.query<{ staked_sats: string }>(
          "SELECT staked_sats::text FROM yield_staking_accounts WHERE pubkey_hash=$1", [owner]);
        const sats = BigInt(result.rows[0]?.staked_sats ?? "0");
        if (sats < 0n || sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid staking balance");
        return { pubkey, staked_sats: Number(sats), vip_status: sats > 10_000n,
          unlocked_features: ["zero_latency_routing"] };
      } finally { client.release(); }
    },
  };
}
