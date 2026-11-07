// Development-only hash-preimage evidence. NOT proof of arbitrary execution.
import { createHash, sign } from "node:crypto";
import { z } from "zod";
import verificationKey from "./zk/clearing-development/verification_key.json";
import { verifyGroth16OffThread } from "./zkVerifierWorker";
import {
  loadPayloadSigningKey,
  payloadPublicIdentity,
} from "../lib/payload-attestation";
import type { ClearingContract } from "./clearingContracts";

export const CLEARING_SCHEME = "clearing-poseidon-preimage-development-v1";
export const CLEARING_RECEIPT_DOMAIN =
  "bitcoinstratigraphy/clearing-development-receipt/v1\n";
export const CLEARING_VERIFICATION_KEY_ID = createHash("sha256")
  .update(JSON.stringify(verificationKey))
  .digest("hex");
const scalarField =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const baseField =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const coordinate = decimal.refine((v) => BigInt(v) < baseField);
const g1 = z.tuple([coordinate, coordinate, z.literal("1")]);
const proofSchema = z
  .object({
    pi_a: g1,
    pi_b: z.tuple([
      z.tuple([coordinate, coordinate]),
      z.tuple([coordinate, coordinate]),
      z.tuple([z.literal("1"), z.literal("0")]),
    ]),
    pi_c: g1,
    protocol: z.literal("groth16"),
    curve: z.literal("bn128"),
  })
  .strict();
const traceSchema = z
  .object({
    scheme: z.literal(CLEARING_SCHEME),
    proof: proofSchema,
    publicSignals: z.tuple([decimal, decimal]),
  })
  .strict();
let pending = 0;

/** No request, option or locally generated key can override the production ban. */
export function developmentClearingEnabled(env = process.env): boolean {
  return (
    ["development", "test"].includes(env.NODE_ENV ?? "") &&
    !env.REPLIT_DEPLOYMENT &&
    env.CLEARING_DEVELOPMENT_SETTLEMENT === "1"
  );
}

export async function verifyClearingExecution(
  contract: ClearingContract,
  trace: string,
) {
  let raw: unknown;
  try {
    raw = JSON.parse(trace);
  } catch {
    return undefined;
  }
  const parsed = traceSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const task = BigInt(`0x${contract.task_hash}`);
  const escrow = BigInt(`0x${contract.escrow_id.replaceAll("-", "")}`);
  const { proof, publicSignals } = parsed.data;
  // Exact canonical decimal signals; never reduce a legacy SHA-256 task hash
  // modulo Fr, trust a caller's task hash, or accept an extra public signal.
  if (
    task >= scalarField ||
    publicSignals[0] !== task.toString() ||
    publicSignals[1] !== escrow.toString()
  )
    return undefined;
  if (pending >= 4) throw new Error("Development verifier busy");
  pending++;
  try {
    if (!(await verifyGroth16OffThread(verificationKey, publicSignals, proof)))
      return undefined;
    return createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
  } finally {
    pending--;
  }
}

export function signDevelopmentClearingReceipt(
  contract: ClearingContract,
  proofDigest: string,
  fundingSettledAt: number,
) {
  const key = loadPayloadSigningKey();
  const settledAt = new Date();
  const payload = JSON.stringify({
    schema: CLEARING_SCHEME,
    receipt_type: "ZK-Indemnity Receipt",
    development_only: true,
    guarantee: "knowledge-of-hash-preimage",
    legal_indemnity_granted: false,
    payout_executed: false,
    status: "settled",
    escrow_id: contract.escrow_id,
    buyer_pubkey: contract.buyer_pubkey,
    worker_pubkey: contract.worker_pubkey,
    task_hash: contract.task_hash,
    amount_sats: Number(contract.amount_sats),
    payment_hash: contract.payment_hash,
    funding_provider: contract.provider,
    funding_verified: true,
    funding_settled_at: fundingSettledAt,
    proof_digest: proofDigest,
    verification_key_id: CLEARING_VERIFICATION_KEY_ID,
    settled_at: settledAt.toISOString(),
  });
  const receipt = {
    payload,
    signature: sign(
      null,
      Buffer.from(CLEARING_RECEIPT_DOMAIN + payload),
      key,
    ).toString("base64"),
    key_id: payloadPublicIdentity(key).keyId,
  };
  return { receipt: JSON.stringify(receipt), settledAt };
}
