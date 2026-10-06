import { createHash } from "node:crypto";
import {
  fetchCurrentBitcoinTip,
  groundEpistemicContext,
  verifyEpistemicAnchorReceipt,
  type BitcoinTip,
} from "./epistemicGrounding";

export type EpistemicDatasetInput = {
  cid: string;
  nostrEventId?: string;
  context?: Record<string, unknown>;
};

const MAX_RECEIPTS = 1_000;
type DatasetReceipt = Awaited<ReturnType<typeof createEpistemicDatasetReceipt>>;
const receiptIndex = new Map<string, DatasetReceipt>();

export async function createEpistemicDatasetReceipt(
  input: EpistemicDatasetInput,
  options: {
    readBitcoinTip?: () => Promise<BitcoinTip>;
    now?: () => number;
  } = {},
) {
  const timestampMs = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new RangeError(
      "Receipt timestamp must be a positive Unix millisecond value",
    );
  }
  const timestamp = new Date(timestampMs).toISOString();
  const tip = await (options.readBitcoinTip ?? fetchCurrentBitcoinTip)();
  // JSON tuple encoding avoids ambiguous concatenations of variable-length fields.
  const receiptHash = createHash("sha256")
    .update(
      JSON.stringify([
        input.cid,
        tip.hash,
        tip.height,
        input.nostrEventId ?? "",
        timestamp,
      ]),
    )
    .digest("hex");
  const receipt = await groundEpistemicContext(
    {
      contextHash: receiptHash,
      agentId: "mcp:proof.epistemic_receipt",
      metadata: {
        cid: input.cid,
        ...(input.nostrEventId ? { nostrEventId: input.nostrEventId } : {}),
        ...(input.context ? { context: input.context } : {}),
      },
    },
    {
      now: () => timestampMs,
      readBitcoinTip: async () => tip,
    },
  );
  const result = {
    receiptHash,
    blockTip: receipt.blockHeight,
    blockHash: receipt.blockHash,
    ipfsCid: input.cid,
    ...(input.nostrEventId ? { nostrEventId: input.nostrEventId } : {}),
    attestation: {
      type: "Signed-Bitcoin-Tip-Anchor",
      // This is the complete signed receipt, not a Groth16 proof. Clients can
      // send JSON.parse(proofPayload) to POST /api/v1/zk/verify as attestation.
      proofPayload: JSON.stringify(receipt),
      verified: true,
    },
    timestamp,
  };
  if (!verifyEpistemicDatasetReceipt(result)) {
    throw new Error("Signed Bitcoin-tip receipt failed self-verification");
  }
  return result;
}

export function verifyEpistemicDatasetReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const attestation = result.attestation as Record<string, unknown> | undefined;
  if (
    !attestation ||
    attestation.type !== "Signed-Bitcoin-Tip-Anchor" ||
    attestation.verified !== true ||
    typeof attestation.proofPayload !== "string" ||
    typeof result.ipfsCid !== "string" ||
    typeof result.receiptHash !== "string" ||
    typeof result.blockHash !== "string" ||
    typeof result.timestamp !== "string" ||
    !Number.isSafeInteger(result.blockTip) ||
    (result.nostrEventId !== undefined &&
      typeof result.nostrEventId !== "string")
  )
    return false;
  try {
    const signed = JSON.parse(attestation.proofPayload) as Record<
      string,
      unknown
    >;
    if (!verifyEpistemicAnchorReceipt(signed)) return false;
    const payload = signed.payload as Record<string, unknown>;
    const metadata = payload.metadata as Record<string, unknown> | undefined;
    return (
      signed.contextHash === result.receiptHash &&
      signed.blockHeight === result.blockTip &&
      signed.blockHash === result.blockHash &&
      new Date(signed.timestamp as number).toISOString() === result.timestamp &&
      metadata?.cid === result.ipfsCid &&
      metadata?.nostrEventId === result.nostrEventId &&
      createHash("sha256")
        .update(
          JSON.stringify([
            result.ipfsCid,
            result.blockHash,
            result.blockTip,
            result.nostrEventId ?? "",
            result.timestamp,
          ]),
        )
        .digest("hex") === result.receiptHash
    );
  } catch {
    return false;
  }
}

export function indexEpistemicDatasetReceipt(receipt: DatasetReceipt): void {
  if (!verifyEpistemicDatasetReceipt(receipt)) {
    throw new Error("Cannot index an invalid signed dataset receipt");
  }
  receiptIndex.delete(receipt.receiptHash);
  receiptIndex.set(receipt.receiptHash, structuredClone(receipt));
  while (receiptIndex.size > MAX_RECEIPTS) {
    receiptIndex.delete(receiptIndex.keys().next().value!);
  }
}

export function getEpistemicDatasetReceiptStatus(
  receiptHash: string,
): string | undefined {
  return receiptIndex.get(receiptHash)?.timestamp;
}

export function getEpistemicDatasetReceiptByHash(
  hashOrCid: string,
): DatasetReceipt | undefined {
  const direct = receiptIndex.get(hashOrCid.toLowerCase());
  if (direct) return structuredClone(direct);
  // Most recent signed anchor wins when a CID has been anchored more than once.
  for (const receipt of [...receiptIndex.values()].reverse()) {
    if (receipt.ipfsCid === hashOrCid) return structuredClone(receipt);
  }
  return undefined;
}
