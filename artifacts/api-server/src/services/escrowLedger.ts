import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pool } from "@workspace/db";
import { ESCROW_GENESIS } from "./escrowGenesis";
export { ESCROW_GENESIS } from "./escrowGenesis";

/** Only this exact earlier seed is eligible for the automatic data upgrade. */
export const LEGACY_ESCROW_GENESIS = Object.freeze({
  escrow_id: "ba4f25dd-7f16-420c-9264-a16f102fd5a6",
  create_payment_hash: "744001477bcd9a6654d3ad7bf4f85e5780cd2631cd46692a07d161893d0058bf",
  settle_preimage: "b32ac2f831f29f2a72efb76ced58fa9d6583128c33afd95fab8f8a78083641dd",
  merkle_root: "d8cd6fe5a388e9422ccc6006969fb01c716291c14b1e85dc4e8a75c2ad134da6",
  amount_sats: 24,
  toll_fee_sats: 24,
  status: "SETTLED",
  ots_calendar_standard: "OpenTimestamps / RFC 6962 SHA-256",
  provenance: "operator_supplied_mainnet_genesis",
  merkle_inclusion_verified: false,
});

export type EscrowState = {
  version: 1;
  contracts: Record<string, unknown>[];
  leaves: Record<string, unknown>[];
};
type LedgerPool = Pick<typeof pool, "connect">;

/**
 * One committed settlement, appended to escrow_ledger_settlements in the same
 * transaction as the snapshot. agentId is the verified agent_id caveat (null
 * when the paid credential carried none); isAuthenticated is true only when
 * that agent_id is a NIP-98 verified Nostr pubkey. Payment fields are null for
 * settlements without a verified Lightning toll.
 */
export type EscrowSettlementRecord = {
  escrowId: string;
  agentId: string | null;
  isAuthenticated: boolean;
  leafIndex: number;
  executionLeafHash: string;
  merkleRoot: string;
  settledAtStrataBlock: number;
  settledAt: string;
  paymentHash: string | null;
  tollSats: number | null;
  settlementProvider: string | null;
};

export async function readGenesisReceipt(database: Pick<typeof pool, "query"> = pool, id = "live-rest-escrow") {
  const { rows } = await database.query(
    "SELECT genesis FROM escrow_ledger WHERE id=$1", [id],
  );
  const genesis = rows[0]?.genesis;
  if (!isDeepStrictEqual(genesis, ESCROW_GENESIS)) {
    throw new Error("Escrow genesis ledger integrity failure");
  }
  // The operator explicitly requested the exact complete historical export,
  // including its already-released settlement preimage.
  return genesis as typeof ESCROW_GENESIS;
}

/** No memory/file fallback: failed database reads or commits fail the request.
 * Row locks span restore -> engine operation -> snapshot commit across replicas.
 * Success (and private preimages) must not reach HTTP until COMMIT succeeds.
 */
export async function withEscrowLedger<T>(
  operation: (state: EscrowState | null) => Promise<{
    state: EscrowState; result: T; settlement?: EscrowSettlementRecord;
  }>,
  database: LedgerPool = pool,
  id = "live-rest-escrow",
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL synchronous_commit = on");
    await client.query(
      "INSERT INTO escrow_ledger (id, genesis) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
      [id, JSON.stringify(ESCROW_GENESIS)],
    );
    const { rows } = await client.query(
      "SELECT state, genesis FROM escrow_ledger WHERE id=$1 FOR UPDATE", [id],
    );
    let genesis = rows[0]?.genesis;
    if (isDeepStrictEqual(genesis, LEGACY_ESCROW_GENESIS)) {
      // Data-only upgrade under the same cross-replica lock. Never alter the
      // escrow state, replace a different genesis, or append a synthetic leaf.
      await client.query(
        "UPDATE escrow_ledger SET genesis=$2::jsonb WHERE id=$1",
        [id, JSON.stringify(ESCROW_GENESIS)],
      );
      genesis = ESCROW_GENESIS;
    }
    if (!isDeepStrictEqual(genesis, ESCROW_GENESIS)
        || createHash("sha256").update(Buffer.from(genesis.settle_response.preimage, "hex")).digest("hex")
          !== genesis.create_response.payment_hash) {
      throw new Error("Escrow genesis ledger integrity failure");
    }
    const out = await operation(rows[0].state);
    if (out.settlement) {
      // Append-only attribution record; a failed insert rolls back the settlement.
      const record = out.settlement;
      await client.query(
        `INSERT INTO escrow_ledger_settlements (ledger_id, escrow_id, agent_id, is_authenticated,
           leaf_index, execution_leaf_hash, merkle_root, settled_at_strata_block, settled_at,
           payment_hash, toll_sats, settlement_provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12)`,
        [id, record.escrowId, record.agentId, record.isAuthenticated, record.leafIndex,
          record.executionLeafHash, record.merkleRoot, record.settledAtStrataBlock,
          record.settledAt, record.paymentHash, record.tollSats, record.settlementProvider],
      );
    }
    await client.query(
      "UPDATE escrow_ledger SET state=$2::jsonb, updated_at=now() WHERE id=$1",
      [id, JSON.stringify(out.state)],
    );
    await client.query("COMMIT");
    return out.result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
