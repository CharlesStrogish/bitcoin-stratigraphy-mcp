import { createHash } from "node:crypto";
import { modelReceipt } from "./model-tools.js";
import { WorkflowPolicyError } from "./risk-policy.js";

// An existing read product, not a fictional compliance receipt or spawning endpoint.
// Its price is determined exclusively by the server's L402 challenge.
export const FUNDING_TOOL = "stratigraphy.get";
export const FUNDING_ARGUMENTS = Object.freeze({ days: 1, limit: 1 });

function verifiedFreshPayment(receipt, startedAt, consumed) {
  const proof = receipt?.cryptographic_proof;
  const hash = receipt?.payment_hash;
  const cost = receipt?.thermodynamic_cost;
  const settledAt = Date.parse(receipt?.timestamp);
  return receipt?.provenance_verified === true &&
    receipt.evidence_scope === "payment_only" &&
    receipt.timestamp_kind === "client_observed_settlement" &&
    typeof proof === "string" && /^[0-9a-f]{64}$/i.test(proof) &&
    typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) &&
    createHash("sha256").update(Buffer.from(proof, "hex")).digest("hex") === hash &&
    typeof cost === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(cost) &&
    /[1-9]/.test(cost) &&
    Number.isFinite(settledAt) && settledAt >= startedAt && settledAt <= Date.now() &&
    !consumed.has(hash);
}

/** One shared admission authority per root run; never accepts model-supplied proofs. */
export function createPaidAdmission(connected, { signal } = {}) {
  const consumed = new Set();
  let active = false;
  let failed = false;
  return async function requestPaidAdmission() {
    signal?.throwIfAborted();
    if (failed) throw new WorkflowPolicyError("PAID_ADMISSION_STOPPED: previous failure requires operator review.");
    if (active) throw new WorkflowPolicyError("PAID_ADMISSION_BUSY: parallel purchases are not allowed.");
    const index = connected.fiduciary.tools.findIndex((entry) => entry.name === FUNDING_TOOL);
    const descriptor = connected.fiduciary.openAITools[index];
    const native = connected.tools.find((entry) => entry.name === descriptor?.function.name);
    if (!native) throw new WorkflowPolicyError("PAID_ADMISSION_UNAVAILABLE: approved MCP read tool is absent.");
    active = true;
    const startedAt = Date.now();
    try {
      // Use the native SDK adapter: discovered schema validation, real 402 invoice,
      // shared durable budgets, wallet proof validation and signed response verification.
      const receipt = await native.invoke({ ...FUNDING_ARGUMENTS });
      signal?.throwIfAborted();
      if (!verifiedFreshPayment(receipt, startedAt, consumed)) {
        throw new WorkflowPolicyError(
          "PAID_ADMISSION_REQUIRED: a fresh settled server invoice and verified response are required; free or reused evidence cannot authorize execution.",
        );
      }
      consumed.add(receipt.payment_hash);
      return JSON.parse(modelReceipt(receipt));
    } catch (error) {
      failed = true; // Never automatically repay or continue after an uncertain outcome.
      if (error instanceof WorkflowPolicyError) throw error;
      throw new WorkflowPolicyError(
        "PAID_ADMISSION_FAILED: invoice settlement or response verification failed. Check shared limits and recovery state; do not automatically repay.",
      );
    } finally {
      active = false;
    }
  };
}
