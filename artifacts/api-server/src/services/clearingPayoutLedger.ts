import type { pool } from "@workspace/db";
import { LndPayoutError, type ClearingPayoutPlan } from "../adapters/lnd";
import type { ClearingPayoutLedger } from "./clearingPayout";

// Separate from the legacy bank escrow and staking tables. No deployment DDL
// or wallet configuration is executed merely by importing this scaffold.
export const CLEARING_PAYOUT_DDL = `
CREATE TABLE IF NOT EXISTS clearing_payouts (
  escrow_id text PRIMARY KEY REFERENCES clearing_contracts(escrow_id),
  payment_hash varchar(64) NOT NULL UNIQUE,
  invoice text NOT NULL,
  principal_msat bigint NOT NULL CHECK (principal_msat > 0),
  fee_limit_sat bigint NOT NULL CHECK (fee_limit_sat >= 0),
  escrow_balance_msat bigint NOT NULL CHECK (escrow_balance_msat >= 0),
  reserved_msat bigint NOT NULL CHECK (reserved_msat >= 0),
  fee_paid_msat bigint,
  status text NOT NULL CHECK (status IN ('reserved','settled','failed')),
  CHECK (principal_msat + fee_limit_sat * 1000 <= escrow_balance_msat OR status='settled')
)`;

export class PostgresClearingPayoutLedger implements ClearingPayoutLedger {
  constructor(private readonly database: Pick<typeof pool, "query">) {}

  /** Explicit future startup step, never called by today's disabled route. */
  async initialize() {
    await this.database.query(CLEARING_PAYOUT_DDL);
  }

  async reserve(escrowId: string, plan: ClearingPayoutPlan) {
    // One immutable payout per clearing contract. Failed records are retained;
    // retry/reconciliation requires a separately reviewed recovery path.
    const result = await this.database.query(
      `INSERT INTO clearing_payouts
       (escrow_id,payment_hash,invoice,principal_msat,fee_limit_sat,
        escrow_balance_msat,reserved_msat,status)
       SELECT escrow_id,$2,$3,$4,$5,$6,$4::bigint+$5::bigint*1000,'reserved'
       FROM clearing_contracts WHERE escrow_id=$1 AND status='pending'
       AND amount_sats * 1000 = $6::bigint
       ON CONFLICT DO NOTHING RETURNING escrow_id`,
      [
        escrowId,
        plan.paymentHash,
        plan.invoice,
        plan.principalMsat.toString(),
        plan.feeLimitSat.toString(),
        plan.escrowBalanceMsat.toString(),
      ],
    );
    return result.rowCount === 1;
  }

  async complete(escrowId: string, plan: ClearingPayoutPlan, feeMsat: bigint) {
    if (feeMsat < 0n || feeMsat > plan.feeLimitSat * 1000n)
      throw new LndPayoutError("CLEARING_ROUTING_FEE_CAP_EXCEEDED", "unknown");
    const result = await this.database.query<{ escrow_balance_msat: string }>(
      `UPDATE clearing_payouts SET status='settled',fee_paid_msat=$4,
       escrow_balance_msat=escrow_balance_msat-principal_msat-$4::bigint,
       reserved_msat=0
       WHERE escrow_id=$1 AND payment_hash=$2 AND invoice=$3
       AND status='reserved' AND principal_msat=$5::bigint
       AND fee_limit_sat=$6::bigint AND escrow_balance_msat=$7::bigint
       AND $4::bigint >= 0 AND $4::bigint <= fee_limit_sat*1000
       AND principal_msat+$4::bigint <= escrow_balance_msat
       RETURNING escrow_balance_msat`,
      [
        escrowId,
        plan.paymentHash,
        plan.invoice,
        feeMsat.toString(),
        plan.principalMsat.toString(),
        plan.feeLimitSat.toString(),
        plan.escrowBalanceMsat.toString(),
      ],
    );
    if (!result.rows[0])
      throw new LndPayoutError("CLEARING_PAYOUT_COMMIT_UNCERTAIN", "unknown");
    return BigInt(result.rows[0].escrow_balance_msat);
  }

  async fail(escrowId: string, plan: ClearingPayoutPlan) {
    await this.database.query(
      `UPDATE clearing_payouts SET status='failed',reserved_msat=0
       WHERE escrow_id=$1 AND payment_hash=$2 AND invoice=$3 AND status='reserved'`,
      [escrowId, plan.paymentHash, plan.invoice],
    );
  }
}
