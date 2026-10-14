import { createHash } from "node:crypto";
import { pool } from "@workspace/db";

/** Released historical escrow proof, explicitly supplied by the operator.
 * This is not a replacement for the unavailable original execution leaf/path.
 */
export const ESCROW_GENESIS = Object.freeze({
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

export async function readGenesisReceipt() {
  const { rows } = await pool.query(
    "SELECT genesis FROM escrow_ledger WHERE id=$1", ["live-rest-escrow"],
  );
  const genesis = rows[0]?.genesis;
  if (!genesis || Object.entries(ESCROW_GENESIS).some(([key, value]) => genesis[key] !== value)) {
    throw new Error("Escrow genesis ledger integrity failure");
  }
  // The complete released preimage is retained privately in the durable ledger.
  const { settle_preimage: _privateProof, ...receipt } = genesis;
  return receipt;
}

/** No memory/file fallback: failed database reads or commits fail the request.
 * Row locks span restore -> engine operation -> snapshot commit across replicas.
 * Success (and private preimages) must not reach HTTP until COMMIT succeeds.
 */
export async function withEscrowLedger<T>(
  operation: (state: EscrowState | null) => Promise<{ state: EscrowState; result: T }>,
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
    const genesis = rows[0]?.genesis;
    if (!genesis || Object.entries(ESCROW_GENESIS).some(([key, value]) => genesis[key] !== value)
        || createHash("sha256").update(Buffer.from(genesis.settle_preimage, "hex")).digest("hex")
          !== genesis.create_payment_hash) {
      throw new Error("Escrow genesis ledger integrity failure");
    }
    const out = await operation(rows[0].state);
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
