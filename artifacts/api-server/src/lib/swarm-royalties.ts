import { pool } from "@workspace/db";
import type { VerifiedSubscriptionMacaroon } from "./subscription-pass";

export function createSwarmRoyalties(database = pool) {
  return {
    async credit(pass: VerifiedSubscriptionMacaroon) {
      if (!pass.swarmReferral || !pass.amountMsats || !pass.paymentProvider) throw new Error("Invalid royalty receipt");
      const gross = BigInt(pass.amountMsats);
      const earned = gross * 5n / 100n;
      const credited = await database.query(
        `INSERT INTO private_swarm_royalties
         (payment_hash,owner,provider,gross_msats,earned_msats,balance_msats)
         SELECT $1,$2,$3,$4,$5,$5 FROM revenue_ledger
         WHERE payment_hash=$1 AND channel='L402' AND sats_received=$6
         ON CONFLICT (payment_hash) DO UPDATE SET payment_hash=EXCLUDED.payment_hash
         WHERE private_swarm_royalties.owner=EXCLUDED.owner
           AND private_swarm_royalties.provider=EXCLUDED.provider
           AND private_swarm_royalties.gross_msats=EXCLUDED.gross_msats
           AND private_swarm_royalties.earned_msats=EXCLUDED.earned_msats
         RETURNING payment_hash`,
        [pass.paymentHash, pass.swarmReferral.owner, pass.paymentProvider,
          gross.toString(), earned.toString(), Math.ceil(pass.amountMsats / 1000)],
      );
      if (credited.rowCount !== 1) throw new Error("Royalty settlement binding failed");
    },
    async balance(owner: string) {
      const result = await database.query<{ payment_hash: string; balance_msats: string }>(
        `SELECT payment_hash,balance_msats::text FROM private_swarm_royalties
         WHERE owner=$1 AND claim_id IS NULL AND balance_msats>0
           AND NOT EXISTS (SELECT 1 FROM private_yield_payout_items i
             WHERE i.source='royalty' AND i.payment_hash=private_swarm_royalties.payment_hash)
         ORDER BY payment_hash LIMIT 32`, [owner]);
      return { royalty_payment_hashes: result.rows.map(row => row.payment_hash),
        claimable_msats: result.rows.reduce((sum, row) => sum + BigInt(row.balance_msats), 0n).toString() };
    },
  };
}
export type SwarmRoyalties = ReturnType<typeof createSwarmRoyalties>;
