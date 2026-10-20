import { isDeepStrictEqual } from "node:util";
import { pool } from "@workspace/db";
import { ESCROW_GENESIS } from "./escrowGenesis";

/** One read-only database snapshot. Never spawn a custody worker for telemetry. */
export async function readEscrowStats(
  database: Pick<typeof pool, "query"> = pool,
  ledgerId = "live-rest-escrow",
) {
  const genesisId = ESCROW_GENESIS.create_response.escrow_id;
  const { rows } = await database.query({
    text: `WITH confirmed AS (
      SELECT escrow_id, toll_sats, execution_leaf_hash, settled_at, leaf_index
      FROM escrow_ledger_settlements
      WHERE ledger_id=$1 AND escrow_id<>$2
        AND payment_hash IS NOT NULL AND toll_sats>0
        AND settlement_provider IS NOT NULL
    )
    SELECT
      (SELECT genesis FROM escrow_ledger WHERE id=$1) AS genesis,
      (SELECT COALESCE(SUM(toll_sats), 0)::text FROM confirmed) AS toll_sats,
      (SELECT COUNT(*)::text FROM confirmed) AS contracts,
      (SELECT execution_leaf_hash FROM confirmed
       ORDER BY settled_at DESC, leaf_index DESC LIMIT 1) AS latest_leaf`,
    values: [ledgerId, genesisId],
  });
  const row = rows[0];
  if (!row) throw new Error("Missing escrow aggregate");
  if (row.genesis !== null && !isDeepStrictEqual(row.genesis, ESCROW_GENESIS)) {
    throw new Error("Escrow genesis ledger integrity failure");
  }
  const hasGenesis = row.genesis !== null;
  const total = Number(row.toll_sats) + (hasGenesis ? ESCROW_GENESIS.create_response.toll_fee_sats : 0);
  const count = Number(row.contracts) + (hasGenesis ? 1 : 0);
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Escrow aggregates exceed safe integer range");
  }
  return {
    total_settled_sats: total,
    total_contracts: count,
    latest_merkle_root: row.latest_leaf ?? (hasGenesis
      ? ESCROW_GENESIS.settle_response.article_12_receipt.execution_leaf_hash : null),
    verified_toll_sats: total,
    settled_contracts: count,
    genesis_escrow_id: hasGenesis ? genesisId : "",
  };
}
