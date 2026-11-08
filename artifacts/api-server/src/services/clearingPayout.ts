import {
  LndPayoutAdapter,
  LndPayoutError,
  lndTransportFromEnvironment,
  type ClearingPayoutPlan,
} from "../adapters/lnd";
import type { ClearingContract } from "./clearingContracts";

export const CLEARING_PAYOUT_DISABLED = "CLEARING_PRODUCTION_PAYOUT_DISABLED";

/**
 * Unconditional production lock. Neither an environment flag nor installed key
 * files authorize live payouts. Called by the authenticated settlement route.
 * Genesis proof receipt settlement does not authorize outbound funds movement.
 * Activation requires a separate reviewed payout integration.
 */
export function requireClearingPayoutActivation(): never {
  throw new LndPayoutError(CLEARING_PAYOUT_DISABLED);
}

/** Route-facing wiring. Deliberately unreachable beyond the hard lock.
 * Replacing the lock requires production proof/funding authorization and
 * contract/receipt coordination, not just installing keys or setting a flag.
 */
export async function settleClearingContractPayout(
  contract: ClearingContract,
  _executionTrace: string,
  invoice: string,
) {
  requireClearingPayoutActivation();
  // Lazy: disabled requests do not initialize SQL or read wallet credentials.
  const [{ pool }, { PostgresClearingPayoutLedger }] = await Promise.all([
    import("@workspace/db"),
    import("./clearingPayoutLedger"),
  ]);
  const ledger = new PostgresClearingPayoutLedger(pool);
  await ledger.initialize();
  return executeFundedClearingPayout(
    contract.escrow_id,
    invoice,
    BigInt(contract.amount_sats) * 1000n,
    new LndPayoutAdapter(lndTransportFromEnvironment()),
    ledger,
  );
}

export interface ClearingPayoutLedger {
  /** Atomic and durable BEFORE sending. Refuse any existing invoice/escrow. */
  reserve(escrowId: string, plan: ClearingPayoutPlan): Promise<boolean>;
  /** Atomically subtract principal + actual fee from this escrow only. */
  complete(
    escrowId: string,
    plan: ClearingPayoutPlan,
    feeMsat: bigint,
  ): Promise<bigint>;
  /** Definitively failed payments only; unknown outcomes stay reserved. */
  fail(escrowId: string, plan: ClearingPayoutPlan): Promise<void>;
}

/**
 * Isolated execution scaffold, NOT connected to an enabled production route.
 * Future caller must first verify the accepted Genesis proof, exact contract
 * binding, NIP-98 worker-signed invoice and merchant-confirmed funded balance.
 * Development receipt settlement must never invoke this engine.
 */
export async function executeFundedClearingPayout(
  escrowId: string,
  invoice: string,
  escrowBalanceMsat: bigint,
  adapter: LndPayoutAdapter,
  ledger: ClearingPayoutLedger,
) {
  const plan = await adapter.prepare(invoice, escrowBalanceMsat);
  if (!(await ledger.reserve(escrowId, plan)))
    throw new LndPayoutError("CLEARING_PAYOUT_ALREADY_RESERVED");
  let paid: Awaited<ReturnType<LndPayoutAdapter["pay"]>>;
  try {
    paid = await adapter.pay(plan);
  } catch (error) {
    if (
      error instanceof LndPayoutError &&
      (error.outcome === "failed" || error.outcome === "not-sent")
    )
      await ledger.fail(escrowId, plan);
    // No retry, second send, or reservation release on an ambiguous outcome.
    throw error;
  }
  // DB failure AFTER payment must also retain the reservation.
  const escrowBalance = await ledger.complete(escrowId, plan, paid.feeMsat);
  return {
    payment_hash: plan.paymentHash,
    principal_msat: plan.principalMsat.toString(),
    routing_fee_msat: paid.feeMsat.toString(),
    escrow_balance_msat: escrowBalance.toString(),
  };
}
