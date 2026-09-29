import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { digestRecord, snapshotBlock, snapshotDate } from "./stratigraphy-index";
import {
  attenuateSubscriptionMacaroon,
  getMacaroonSignatureId,
  verifySubscriptionMacaroon,
} from "../lib/subscription-pass";
import type { MacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import { createPostgresMacaroonRevocationStore } from "../lib/postgres-macaroon-revocation-store";
import { parseL402Header } from "../middleware/l402";
import {
  createEpistemicDatasetReceipt,
  getEpistemicDatasetReceiptByHash,
  indexEpistemicDatasetReceipt,
} from "../services/epistemicDatasetReceipt";
import { createL402Middleware } from "../middleware/l402";
import {
  createCdpX402ResourceServer,
  createX402PaymentMiddleware,
  type X402ResourceServerLike,
} from "../middleware/payment";
import { createDefaultMultiSettlementRouter } from "../services/multiSettlement";
import type { SettlementRouter } from "../services/settlement";
import type { MacaroonUsageStore } from "../lib/macaroon-usage-store";
import type { RevenueLedger } from "../services/ledger";
import {
  groundEpistemicContext,
  getGroundedContextReceipt,
  indexGroundedContextReceipt,
  type BitcoinTip,
} from "../services/epistemicGrounding";
import {
  createMeshGossipService,
  MeshQuorumError,
  type MeshGossipService,
} from "../services/meshGossipService";
import { createNostrAttestor } from "../services/nostrAttestation";
import {
  getZkProofRecord,
  getZkProofStatus,
  listZkProofAttestations,
  submitZkProof,
  verifyZkProofForSnapshot,
} from "../services/zkProofService";
import { verifyDriftProof } from "../services/zkDriftService";
import { getStratigraphyData, readDataset } from "./stratigraphy";
import { buildProvenanceChain } from "../services/provenanceChain";
import { getProvenanceAnchor, verifyOtsProofRecord, type OtsVerificationResult } from "../services/otsProvenance";
import {
  createHttpRateLimitMiddleware,
  createSlidingWindowRateLimiter,
} from "../middleware/rateLimiter";

const documented = <T extends z.ZodType>(
  schema: T,
  description: string,
  _examples: unknown[],
): T => schema.describe(description) as T;

const quantitativeAlphaSchema = z.object({
  target_multiplier: documented(
    z.number(),
    "Thermodynamic valuation multiplier derived for this day.",
    [125.83],
  ),
  difficulty_epoch_progress: documented(
    z.string().min(1),
    "Bitcoin mining difficulty epoch progress formatted as a percentage.",
    ["73.42%"],
  ),
  thermodynamic_signal: documented(
    z.string().min(1),
    "Human-readable thermodynamic market signal.",
    ["accumulation"],
  ),
}).describe("Quantitative thermodynamic indicators for one stratigraphy entry");

const entrySchema = z.object({
  day: documented(
    z.number().int(),
    "One-based day number in the Bitcoin Stratigraphy dataset.",
    [422],
  ),
  title: documented(
    z.string(),
    "Title of the source research episode.",
    ["Bitcoin Stratigraphy Day 422"],
  ),
  video_id: documented(
    z.string(),
    "Source video identifier used to trace the research provenance.",
    ["dQw4w9WgXcQ"],
  ),
  transcript_summary: documented(
    z.string(),
    "Concise summary of the source transcript and market interpretation.",
    ["Mining economics and thermodynamic support strengthened."],
  ),
  quantitative_alpha: quantitativeAlphaSchema,
}).describe("A validated Bitcoin Stratigraphy telemetry entry");

const publicInputsSchema = z.object({
  blockHeight: documented(
    z.number().int().nonnegative(),
    "Bitcoin block height committed into the proof.",
    [920000],
  ),
  snapshotDigest: documented(
    z.string().min(1),
    "Poseidon field digest of the canonical snapshot payload.",
    ["1534979302823651498736582947365829473658294736582947365829473658294"],
  ),
  thermodynamicHash: documented(
    z.string().min(1),
    "Poseidon field hash of the thermodynamic telemetry values.",
    ["782365829473658294736582947365829473658294736582947365829473658294"],
  ),
  timestamp: documented(
    z.number().int().nonnegative(),
    "Unix timestamp in milliseconds committed into the proof.",
    [1789776000000],
  ),
  valuationSat: documented(
    z.number().int().nonnegative(),
    "Satoshi valuation committed into the proof.",
    [12583],
  ),
}).strict().describe(
  "Public statement inputs committed by the Groth16/Poseidon proof.",
);

const snapshotSchema = documented(
  z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())),
  ]),
  "Telemetry snapshot payload whose canonical digest and semantic fields must match the proof.",
  [[{
    block: { height: 920000 },
    observed_at: "2026-09-19T00:00:00.000Z",
    thermodynamic: { target_multiplier: 125.83 },
  }]],
);

const meshStatusSchema = {
  nodePubkey: documented(
    z.string(),
    "Lowercase hexadecimal Nostr public key identifying this mesh node.",
    ["f72cc555ec2948fdc4b5b2c2778821499ea8ce2b8569b68675899e296d3ff253"],
  ),
  activePeerCount: documented(
    z.number().int().min(1),
    "Number of recently validated nodes, including the local node.",
    [3],
  ),
  configuredPeerCount: documented(
    z.number().int().nonnegative(),
    "Number of remotely configured trusted peers.",
    [2],
  ),
  topologyHealth: documented(
    z.enum(["healthy", "degraded", "isolated"]),
    "Current consensus topology health classification.",
    ["healthy"],
  ),
  crossValidationSuccessRate: documented(
    z.number().min(0).max(1),
    "Lifetime ratio of successful peer cross-validation attempts.",
    [0.98],
  ),
  averagePropagationLatencyMs: documented(
    z.number().nonnegative(),
    "Mean round-trip propagation latency for successful attestations.",
    [42.7],
  ),
  quorumThreshold: documented(
    z.number().int().min(1),
    "Minimum number of unique node attestations required for consensus.",
    [2],
  ),
};

const readOnlyToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnly: true,
  audience: ["assistant"],
  priority: 1,
  zkProof: {
    included: true,
    scheme: "Groth16/Poseidon BN254",
    verificationEndpoint: "POST /api/v1/zk/verify",
    targetVerificationTime: "sub-10ms for proofs emitted by this API",
  },
};

const submissionToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  readOnly: false,
  audience: ["assistant"],
  priority: 1,
};

// Mesh status observes external peers but does not change their state.
const meshStatusToolAnnotations = {
  ...readOnlyToolAnnotations,
  openWorldHint: true,
};

// Verification changes the observable in-memory lifecycle index, including
// verified -> cached on repeat calls, even though it does not publish to Nostr.
const proofVerificationToolAnnotations = {
  ...readOnlyToolAnnotations,
  readOnlyHint: false,
  idempotentHint: false,
  readOnly: false,
};

const thermodynamicMetricNames = [
  "target_multiplier",
  "difficulty_epoch_progress",
  "thermodynamic_signal",
] as const;

const stratigraphyInputSchema = z.object({
  days: z.number().int().min(1).max(365).optional().describe(
    "Count of recent days of telemetry to fetch.",
  ),
  date: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Calendar date selecting one telemetry day, formatted as YYYY-MM-DD.",
  ),
  blockHeight: z.number().int().min(0).optional().describe(
    "Indexed Bitcoin block height selecting one telemetry record.",
  ),
  metrics: z.array(
    z.enum(thermodynamicMetricNames).describe(
      "Thermodynamic metric name to include in each returned record.",
    ),
  ).min(1).refine(
    (values) => new Set(values).size === values.length,
    "metrics must contain unique values",
  ).optional().describe(
    "Telemetry metrics projected into each returned record.",
  ),
  startDate: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Inclusive UTC lower date bound (YYYY-MM-DD); can be used alone or with endDate, but not with date or blockHeight.",
  ),
  endDate: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Inclusive UTC upper date bound (YYYY-MM-DD); can be used alone or with startDate, but not with date or blockHeight.",
  ),
  startBlock: z.number().int().nonnegative().optional().describe(
    "Inclusive lower bound of the daily block-height index; can be used alone or with endBlock, but not with date or blockHeight.",
  ),
  endBlock: z.number().int().nonnegative().optional().describe(
    "Inclusive upper bound of the daily block-height index; can be used alone or with startBlock, but not with date or blockHeight.",
  ),
  limit: z.number().int().min(1).max(100).default(10).describe(
    "Maximum number of records to return.",
  ),
}).strict().superRefine((input, context) => {
  const legacySelectors = [
    input.days !== undefined,
    input.date !== undefined,
    input.blockHeight !== undefined,
  ].filter(Boolean).length;
  const hasRangeSelector =
    input.startDate !== undefined ||
    input.endDate !== undefined ||
    input.startBlock !== undefined ||
    input.endBlock !== undefined;
  if (legacySelectors > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide only one of days, date, or blockHeight",
    });
  }
  if (legacySelectors > 0 && hasRangeSelector) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Legacy selectors cannot be combined with range selectors",
    });
  }
  if (
    input.startDate !== undefined &&
    input.endDate !== undefined &&
    input.startDate > input.endDate
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startDate must not be later than endDate",
    });
  }
  if (
    input.startBlock !== undefined &&
    input.endBlock !== undefined &&
    input.startBlock > input.endBlock
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startBlock must not be greater than endBlock",
    });
  }
}).describe("Validated raw stratigraphy telemetry query parameters.");

const stratigraphyDigestInputSchema = z.object({
  target: z.string().regex(/^(?:latest|(?:0|[1-9]\d*)|\d{4}-\d{2}-\d{2}(?:\.\.\d{4}-\d{2}-\d{2})?)$/).default("latest"),
  format: z.enum(["compact", "minimal", "kv"]).default("compact"),
}).strict().superRefine(({ target }, context) => {
  if (target === "latest") return;
  if (/^\d+$/.test(target)) {
    if (Number.isSafeInteger(Number(target))) return;
    context.addIssue({ code: z.ZodIssueCode.custom, message: "target height is too large" });
    return;
  }
  const dates = target.split("..");
  for (const date of dates) {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "target must contain a valid ISO calendar date" });
      return;
    }
  }
  if (dates.length === 2 && (
    dates[0] > dates[1] ||
    (Date.parse(dates[1]) - Date.parse(dates[0])) / DAY_MS >= 100
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "target range must be ascending and cover at most 100 days" });
  }
});

const diffTargetPattern = "^(?:(?:0|[1-9]\\d*)|\\d{4}-\\d{2}-\\d{2})$";
const diffEndTargetPattern = "^(?:latest|(?:0|[1-9]\\d*)|\\d{4}-\\d{2}-\\d{2})$";
function validDiffTarget(target: string): boolean {
  if (target === "latest") return true;
  if (/^\d+$/.test(target)) return Number.isSafeInteger(Number(target));
  const parsed = new Date(`${target}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === target;
}
const stratigraphyDiffInputSchema = z.object({
  fromTarget: z.string().regex(new RegExp(diffTargetPattern)).refine(validDiffTarget),
  toTarget: z.string().regex(new RegExp(diffEndTargetPattern)).refine(validDiffTarget).default("latest"),
}).strict();

const stratigraphyRangeInputSchema = z.object({
  startTarget: z.string().regex(new RegExp(diffTargetPattern)).refine(validDiffTarget),
  endTarget: z.string().regex(new RegExp(diffEndTargetPattern)).refine(validDiffTarget).default("latest"),
  limit: z.number().int().min(1).max(100).default(50),
  format: z.enum(["compact", "minimal", "kv"]).default("compact"),
}).strict();

const attenuateInputSchema = z.object({
  macaroon: z.string().min(1).max(8192),
  caveats: z.array(z.string().min(1).max(256)).max(16),
  ttlSeconds: z.number().int().positive().max(2_592_000).optional(),
}).strict().refine(({ caveats, ttlSeconds }) => caveats.length > 0 || ttlSeconds !== undefined, {
  message: "At least one caveat or ttlSeconds is required",
});

const stratigraphyCatalogInputSchema = z.object({}).strict().describe(
  "No input parameters required.",
);

const verifySnapshotProofInputSchema = z.object({
  proof: z.string().min(1).describe(
    "Base64url-encoded Groth16/Poseidon BN254 proof emitted by this API, without padding.",
  ),
  publicInputs: publicInputsSchema.describe(
    "Expected public constants committed by the proof; blockHeight, snapshotDigest, thermodynamicHash, timestamp, and valuationSat must match the telemetry payload in data.",
  ),
  verificationKeyId: z.string().min(1).describe(
    "SHA-256 verification-key identifier using the sha256: prefix.",
  ),
  data: snapshotSchema,
}).strict().describe(
  "Input arguments containing an encoded Groth16 proof, typed public inputs, a verification-key identifier, and telemetry data.",
);

const driftProofInputSchema = z.object({
  circuit: z.literal("zk.drift.v1"),
  sessionContextHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  targetBlockHeight: z.number().int().nonnegative().max(0xffff_ffff),
  entropyThreshold: z.number().min(0).max(1),
  proof: z.object({
    circuit: z.literal("zk.drift.v1"),
    pi_a: z.array(z.string().min(1)).length(3),
    pi_b: z.array(z.array(z.string().min(1)).length(2)).length(3),
    pi_c: z.array(z.string().min(1)).length(3),
    publicSignals: z.array(z.string().min(1)).min(1),
    verificationKeyId: z.string().min(1),
  }).strict(),
  driftScore: z.number().optional(),
  isAligned: z.boolean().optional(),
  thermodynamicEntropyBits: z.number().nonnegative().optional(),
  blockHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  compactTarget: z.number().int().min(0).max(0xffff_ffff).optional(),
}).strict();

const verifyProofInputSchema = z.union([
  verifySnapshotProofInputSchema.extend({ proofType: z.literal("groth16").optional() }),
  driftProofInputSchema.extend({ proofType: z.literal("groth16").optional() }),
  z.object({
    proofType: z.literal("ots"),
    otsProof: z.string().min(1).max(1_048_576),
    targetHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  }).strict(),
]);

const settleInputSchema = z.object({
  paymentHash: z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$/).describe(
    "For L402, the challenged 32-byte Lightning payment hash; for x402, the Base transaction hash (same value as txHash).",
  ),
  preimage: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe(
    "L402 32-byte hex preimage. Also send the server-issued L402 macaroon and the same preimage in the Authorization header.",
  ),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe(
    "Base transaction hash; requires a valid PAYMENT-SIGNATURE settled upfront by the x402 facilitator on this request.",
  ),
}).strict();

type SettlementCheck = {
  verified: boolean;
  settlementToken: null | {
    scheme: "L402" | "x402";
    paymentHash: string;
    scope: string;
    settledAt: string;
  };
};

const proofStatusInputSchema = z.object({
  proofHash: z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$|^Qm[1-9A-HJ-NP-Za-km-z]{44}$|^b[a-z2-7]{20,}$/).optional().describe(
    "Primary lookup key for a proof lifecycle record (hex digest or CID); mutually exclusive with snapshotDigest.",
  ),
  snapshotDigest: z.string().regex(/^(?:\d+|[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/).optional().describe(
    "Primary lookup key for a snapshot lifecycle record (decimal digest, hex digest, or CID); mutually exclusive with proofHash.",
  ),
  receiptHash: z.string().regex(/^[0-9a-f]{64}$/).optional().describe(
    "SHA-256 digest returned by proof.issue_receipt; mutually exclusive with proofHash and snapshotDigest.",
  ),
}).strict().refine(
  (input) => [input.proofHash, input.snapshotDigest, input.receiptHash]
    .filter((value) => value !== undefined).length === 1,
  "Provide exactly one of proofHash, snapshotDigest, or receiptHash",
).describe("Input arguments for querying single proof attestation lifecycle status.");

const proofLifecycleStates = [
  "verified",
  "cached",
  "pending",
  "invalid",
] as const;

const proofByHashInputSchema = z.object({
  hash: z.string().regex(/^(?:(?:0x)?[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|\d{1,77}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/).optional(),
  jobId: z.string().uuid().optional(),
}).strict().refine(({ hash, jobId }) => (hash === undefined) !== (jobId === undefined), {
  message: "Provide exactly one hash or jobId",
});

const paymentInfoInputSchema = z.object({
  action: z.literal("query").optional(),
  toolName: z.string().min(1).optional(),
}).strict().or(settleInputSchema.extend({ action: z.literal("settle") }).refine(
  (value) => Number(value.preimage !== undefined) + Number(value.txHash !== undefined) === 1,
  "Provide exactly one of preimage or txHash",
));

type ArchivedProofLookup = {
  kind: "zk-proof" | "dataset-receipt" | "context-receipt" | "zk-proof-status";
  hash: string;
  status: "verified" | "cached" | "pending" | "invalid";
  timestamp: string;
  proofPayload?: Record<string, unknown>;
  attestationCount?: number;
  meshQuorum?: boolean;
  jobId?: string;
};

type BoundProvenance = { headHash: string; merkleRoot: string; totalDepth: number };

function boundProvenance(value: unknown): BoundProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Record<string, unknown>;
  return /^[0-9a-f]{64}$/.test(String(state.headHash)) &&
    /^[0-9a-f]{64}$/.test(String(state.merkleRoot)) &&
    Number.isSafeInteger(state.totalDepth) && (state.totalDepth as number) > 0
    ? state as BoundProvenance : undefined;
}

function receiptProvenance(value: unknown): BoundProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  if (receipt.attestation && typeof (receipt.attestation as Record<string, unknown>).proofPayload === "string") {
    try {
      const signed = JSON.parse((receipt.attestation as { proofPayload: string }).proofPayload) as {
        payload?: { metadata?: { context?: { datasetProvenance?: unknown } } };
      };
      return boundProvenance(signed.payload?.metadata?.context?.datasetProvenance);
    } catch { return undefined; }
  }
  return boundProvenance((receipt.payload as { metadata?: { datasetProvenance?: unknown } } | undefined)
    ?.metadata?.datasetProvenance);
}

async function provenanceForReceipt(receipt: unknown) {
  const bound = receiptProvenance(receipt);
  if (!bound) return { provenanceVerified: false };
  const chain = buildProvenanceChain(await readDataset());
  if (chain.headHash !== bound.headHash || chain.merkleRoot !== bound.merkleRoot ||
      chain.totalDepth !== bound.totalDepth || !chain.verified) {
    return { provenanceVerified: false };
  }
  const anchor = await getProvenanceAnchor(bound.headHash);
  if (anchor && (anchor.merkleRoot !== bound.merkleRoot || anchor.totalDepth !== bound.totalDepth)) {
    return { provenanceVerified: false };
  }
  return {
    provenanceVerified: true,
    provenanceMerkleRoot: bound.merkleRoot,
    ...(anchor ? { otsProof: anchor.otsProof, otsStatus: anchor.otsStatus } : {}),
  };
}

function findArchivedProof(hash: string, quorumThreshold: number): ArchivedProofLookup | undefined {
  const proof = getZkProofRecord(hash);
  if (proof) return proof;
  const receipt = getEpistemicDatasetReceiptByHash(hash);
  if (receipt) return {
    kind: "dataset-receipt",
    hash: receipt.receiptHash,
    status: "verified",
    timestamp: receipt.timestamp,
    proofPayload: receipt,
  };
  const contextReceipt = getGroundedContextReceipt(hash);
  if (contextReceipt) return {
    kind: "context-receipt",
    hash: contextReceipt.contextHash,
    status: "verified",
    timestamp: new Date(contextReceipt.timestamp).toISOString(),
    proofPayload: contextReceipt,
  };
  const history = getZkProofStatus(hash) ??
    (/^(?:0x)?[0-9a-fA-F]{64}$/.test(hash)
      ? getZkProofStatus(`0x${hash.replace(/^0x/i, "").toLowerCase()}`)
      : undefined);
  if (!history) return undefined;
  return {
    kind: "zk-proof-status",
    hash,
    status: history.status,
    timestamp: history.verifiedAt,
    attestationCount: history.attestationCount,
    meshQuorum: history.attestationCount >= quorumThreshold,
  };
}

const listProofAttestationsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe(
    "Pagination window size, 1-100 records; use with offset to page through the bounded attestation index.",
  ),
  offset: z.number().int().min(0).max(1_000).default(0).describe(
    "Zero-based pagination skip offset, 0-1000; increase by limit to page through historical attestations.",
  ),
  status: z.enum(proofLifecycleStates).optional().describe(
    "Filter the attestation index to one lifecycle state: verified, cached, pending, or invalid.",
  ),
}).strict().describe(
  "Input options for listing and discovering historical zk-SNARK proof attestations.",
);

const proofPointASchema = z.array(
  z.string().regex(/^\d+$/).describe("Decimal-encoded BN254 scalar-field coordinate in proof point A."),
).length(3).describe("Groth16 BN254 proof A projective coordinates.");
const proofPointBSchema = z.array(
  z.array(
    z.string().regex(/^\d+$/).describe("Decimal-encoded BN254 extension-field coordinate in proof point B."),
  ).length(2),
).length(3).describe("Groth16 BN254 proof B projective coordinates.");
const proofPointCSchema = z.array(
  z.string().regex(/^\d+$/).describe("Decimal-encoded BN254 scalar-field coordinate in proof point C."),
).length(3).describe("Groth16 BN254 proof C projective coordinates.");

const submitProofInputSchema = z.object({
  proof: z.union([
    z.object({ piA: proofPointASchema, piB: proofPointBSchema, piC: proofPointCSchema }).strict(),
    z.object({ pi_a: proofPointASchema, pi_b: proofPointBSchema, pi_c: proofPointCSchema }).strict(),
  ]).describe(
    "Groth16/Poseidon BN254 proof coordinates piA, piB, and piC (or legacy pi_a, pi_b, pi_c) for verification and optional NIP-78 publication.",
  ),
  publicSignals: z.array(
    z.string().regex(/^\d+$/).describe(
      "Decimal-encoded BN254 scalar-field element.",
    ),
  ).length(5).describe(
    "Five ordered public signals: blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest; must align with the proof coordinates.",
  ),
  snapshotDigest: z.string().regex(/^(?:\d+|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/).optional().describe(
    "Decimal field digest or IPFS CID that must equal publicSignals[4] when supplied.",
  ),
}).strict().superRefine((input, context) => {
  if (
    input.snapshotDigest !== undefined &&
    input.snapshotDigest !== input.publicSignals[4]
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["snapshotDigest"],
      message: "snapshotDigest must equal publicSignals[4]",
    });
  }
}).describe(
  "Input payload containing Groth16 proof object and public signals for ingestion and Nostr NIP-78 attestation broadcast.",
);

const meshStatusInputSchema = z.object({}).strict().describe(
  "No input parameters required.",
);

const meshBroadcastInputSchema = z.object({
  signalType: z.literal("telemetry_snapshot").describe(
    "Enforces the broadcast event schema; only telemetry_snapshot triggers peer validation for a freshly signed canonical record.",
  ),
  payload: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
      "UTC YYYY-MM-DD date of the existing stratigraphy record to broadcast.",
    ),
  }).strict().describe("UTC date selector for the existing telemetry record sent for peer attestation; arbitrary caller-supplied snapshots are not accepted."),
  agentEvent: z.object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
    kind: z.literal(20079),
    created_at: z.number().int(),
    tags: z.array(z.array(z.string())),
    content: z.string(),
  }).strict().optional().describe(
    'Optional fresh NIP-01 agent session event. Sign JSON.stringify({networkId,date}) with kind 20079; the date must match payload.date. The agent must have a trusted mesh attestation.',
  ),
}).strict().describe("Request to broadcast one signed telemetry snapshot to configured, pinned mesh peers.");

const groundContextInputSchema = z.object({
  contextHash: z.string().regex(/^[0-9a-fA-F]{64}$/).describe(
    "64-character hexadecimal SHA-256 digest binding the agent's prompt or execution context to the current Bitcoin block tip.",
  ),
  agentId: z.string().trim().min(1).max(256).describe(
    "Unique, trimmed caller-controlled agent instance identifier from 1 to 256 characters, named in the signed receipt.",
  ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    "Non-secret caller metadata bound into the context anchor.",
  ),
}).strict().describe("Paid epistemic context grounding request.");

const epistemicDatasetInputSchema = z.object({
  cid: z.string().max(256).regex(/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|(?:0x)?[0-9a-fA-F]{64})$/).describe(
    "IPFS CIDv0/CIDv1 or 32-byte hexadecimal dataset hash to bind into the signed receipt.",
  ),
  nostrEventId: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe(
    "Optional 32-byte hexadecimal Nostr event ID to bind into the signed receipt; this tool does not publish it.",
  ),
  context: z.record(z.string(), z.unknown()).optional().describe(
    "Optional non-secret JSON context bound to the signed receipt (maximum 16 KiB together with the other metadata).",
  ),
}).strict().describe("Dataset CID and optional publication context for a Bitcoin-tip signed receipt.");
const proofGroundInputSchema = z.union([groundContextInputSchema, epistemicDatasetInputSchema]);

const field = (
  type: string | string[],
  description: string,
  examples: unknown[],
  extra: Record<string, unknown> = {},
) => {
  const constraints = [
    ...(["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "format", "pattern"] as const)
      .filter((key) => extra[key] !== undefined)
      .map((key) => `${key}: ${extra[key]}`),
    ...(Array.isArray(extra.enum) ? [`allowed values: ${extra.enum.join(", ")}`] : []),
  ];
  return {
    type,
    description: `${description}${constraints.length ? ` Constraints: ${constraints.join("; ")}.` : ""} Example: ${JSON.stringify(examples[0])}.`,
    example: examples[0],
    examples,
    ...extra,
  };
};

const quantitativeAlphaJsonSchema = {
  type: "object",
  description: "Quantitative thermodynamic indicators for one entry.",
  examples: [{
    target_multiplier: 125.83,
    difficulty_epoch_progress: "73.42%",
    thermodynamic_signal: "accumulation",
  }],
  additionalProperties: false,
  properties: {
    target_multiplier: field(
      "number",
      "Thermodynamic valuation multiplier derived for this day.",
      [125.83],
    ),
    difficulty_epoch_progress: field(
      "string",
      "Bitcoin mining difficulty epoch progress formatted as a percentage.",
      ["73.42%"],
    ),
    thermodynamic_signal: field(
      "string",
      "Human-readable thermodynamic market signal.",
      ["accumulation"],
    ),
  },
};

const entryJsonSchema = {
  type: "object",
  description: "A validated Bitcoin Stratigraphy telemetry entry.",
  examples: [{
    day: 422,
    title: "Bitcoin Stratigraphy Day 422",
    video_id: "dQw4w9WgXcQ",
    transcript_summary: "Mining economics and thermodynamic support strengthened.",
    quantitative_alpha: quantitativeAlphaJsonSchema.examples[0],
  }],
  additionalProperties: false,
  properties: {
    day: field(
      "integer",
      "One-based day number in the Bitcoin Stratigraphy dataset.",
      [422],
    ),
    title: field("string", "Title of the source research episode.", [
      "Bitcoin Stratigraphy Day 422",
    ]),
    video_id: field(
      "string",
      "Source video identifier used to trace research provenance.",
      ["dQw4w9WgXcQ"],
    ),
    transcript_summary: field(
      "string",
      "Concise summary of the source transcript and market interpretation.",
      ["Mining economics and thermodynamic support strengthened."],
    ),
    quantitative_alpha: quantitativeAlphaJsonSchema,
  },
  required: [
    "day",
    "title",
    "video_id",
    "transcript_summary",
    "quantitative_alpha",
  ],
};

const publicInputsJsonSchema = {
  type: "object",
  description:
    "Exactly five public statement inputs committed by the Groth16/Poseidon proof: non-negative integer blockHeight, non-empty Poseidon snapshotDigest and thermodynamicHash strings, non-negative Unix-millisecond timestamp, and non-negative integer valuationSat. Example: blockHeight 920000 and valuationSat 12583.",
  examples: [{
    blockHeight: 920000,
    snapshotDigest: "1534979302823651498736582947365829473658294736582947365829473658294",
    thermodynamicHash: "782365829473658294736582947365829473658294736582947365829473658294",
    timestamp: 1789776000000,
    valuationSat: 12583,
  }],
  additionalProperties: false,
  properties: {
    blockHeight: field(
      "integer",
      "Bitcoin block height committed into the proof.",
      [920000],
      { minimum: 0 },
    ),
    snapshotDigest: field(
      "string",
      "Poseidon field digest of the canonical snapshot payload.",
      ["1534979302823651498736582947365829473658294736582947365829473658294"],
      { minLength: 1 },
    ),
    thermodynamicHash: field(
      "string",
      "Poseidon field hash of the thermodynamic telemetry values.",
      ["782365829473658294736582947365829473658294736582947365829473658294"],
      { minLength: 1 },
    ),
    timestamp: field(
      "integer",
      "Unix timestamp in milliseconds committed into the proof.",
      [1789776000000],
      { minimum: 0 },
    ),
    valuationSat: field(
      "integer",
      "Satoshi valuation committed into the proof.",
      [12583],
      { minimum: 0 },
    ),
  },
  required: [
    "blockHeight",
    "snapshotDigest",
    "thermodynamicHash",
    "timestamp",
    "valuationSat",
  ],
};

const meshStatusJsonProperties = {
  nodePubkey: field(
    "string",
    "Lowercase hexadecimal Nostr public key identifying this mesh node.",
    ["f72cc555ec2948fdc4b5b2c2778821499ea8ce2b8569b68675899e296d3ff253"],
  ),
  activePeerCount: field(
    "integer",
    "Number of recently validated nodes, including the local node.",
    [3],
    { minimum: 1 },
  ),
  configuredPeerCount: field(
    "integer",
    "Number of remotely configured trusted peers.",
    [2],
    { minimum: 0 },
  ),
  topologyHealth: field(
    "string",
    "Current consensus topology health classification.",
    ["healthy"],
    { enum: ["healthy", "degraded", "isolated"] },
  ),
  crossValidationSuccessRate: field(
    "number",
    "Lifetime ratio of successful peer cross-validation attempts.",
    [0.98],
    { minimum: 0, maximum: 1 },
  ),
  averagePropagationLatencyMs: field(
    "number",
    "Mean round-trip propagation latency for successful attestations.",
    [42.7],
    { minimum: 0 },
  ),
  quorumThreshold: field(
    "integer",
    "Minimum unique node attestations required for consensus.",
    [2],
    { minimum: 1 },
  ),
};

const DAY_MS = 86_400_000;
const catalogMetricNames = [
  "day",
  "title",
  "video_id",
  "transcript_summary",
  "quantitative_alpha.target_multiplier",
  "quantitative_alpha.difficulty_epoch_progress",
  "quantitative_alpha.thermodynamic_signal",
] as const;

async function stratigraphyCatalog() {
  const records = await getStratigraphyData();
  return {
    totalSnapshots: records.length,
    oldestBlock: snapshotBlock(0, records.length),
    newestBlock: snapshotBlock(records.length - 1, records.length),
    availableMetrics: [...catalogMetricNames],
    dateBounds: {
      startDate: snapshotDate(0, records.length),
      endDate: snapshotDate(records.length - 1, records.length),
    },
  };
}

async function queryStratigraphy(
  input: z.infer<typeof stratigraphyInputSchema>,
) {
  const legacySelectors = [
    input.days !== undefined,
    input.date !== undefined,
    input.blockHeight !== undefined,
  ].filter(Boolean).length;
  const hasLegacySelector = legacySelectors > 0;
  const hasRangeSelector =
    input.startDate !== undefined ||
    input.endDate !== undefined ||
    input.startBlock !== undefined ||
    input.endBlock !== undefined;
  if (hasLegacySelector && hasRangeSelector) {
    throw new RangeError(
      "days, date, or blockHeight cannot be combined with date or block ranges",
    );
  }
  if (legacySelectors > 1) {
    throw new RangeError("Provide only one of days, date, or blockHeight");
  }
  if (
    input.startDate !== undefined &&
    input.endDate !== undefined &&
    input.startDate > input.endDate
  ) {
    throw new RangeError("startDate must not be later than endDate");
  }
  if (
    input.startBlock !== undefined &&
    input.endBlock !== undefined &&
    input.startBlock > input.endBlock
  ) {
    throw new RangeError("startBlock must not be greater than endBlock");
  }
  const allRecords = await getStratigraphyData();
  let records = hasLegacySelector
    ? input.blockHeight === undefined
      ? (await getStratigraphyData({
          days: input.days,
          date: input.date,
        })).slice(-input.limit)
      : allRecords.filter((_record, index) =>
          snapshotBlock(index, allRecords.length) === input.blockHeight
        ).slice(0, input.limit)
    : allRecords.filter((_record, index) => {
      const date = snapshotDate(index, allRecords.length);
      const block = snapshotBlock(index, allRecords.length);
      return (
        (input.startDate === undefined || date >= input.startDate) &&
        (input.endDate === undefined || date <= input.endDate) &&
        (input.startBlock === undefined || block >= input.startBlock) &&
        (input.endBlock === undefined || block <= input.endBlock)
      );
    }).slice(0, input.limit);

  if (input.metrics !== undefined) {
    const selected = new Set(input.metrics);
    records = records.map((record) => ({
      ...record,
      quantitative_alpha: Object.fromEntries(
        Object.entries(record.quantitative_alpha).filter(([name]) =>
          selected.has(name as typeof thermodynamicMetricNames[number])
        ),
      ) as typeof record.quantitative_alpha,
    }));
  }
  return records;
}

type StratumRecord = Awaited<ReturnType<typeof getStratigraphyData>>[number];

function indexedStratumIndex(target: string, records: StratumRecord[]): number {
  if (records.length === 0) throw new RangeError("No indexed stratigraphy records available");
  if (target === "latest") return records.length - 1;
  if (/^\d+$/.test(target)) {
    const height = Number(target);
    if (!Number.isSafeInteger(height)) throw new RangeError("Target height is too large");
    const index = records.findIndex((_record, i) => snapshotBlock(i, records.length) === height);
    if (index >= 0) return index;
  } else {
    const index = records.findIndex((_record, i) => snapshotDate(i, records.length) === target);
    if (index >= 0) return index;
  }
  throw new RangeError(`No indexed stratum matches target: ${target}`);
}

function formatDigestRecord(record: StratumRecord, index: number, total: number, format: "compact" | "minimal" | "kv") {
  const { height, date, targetMultiplier, recordHash } = digestRecord(record, index, total);
  if (format === "minimal") return [height, date, targetMultiplier, recordHash];
  if (format === "kv") return { h: height, ts: date, tm: targetMultiplier, hash: recordHash };
  return `HEIGHT:${height}|DATE:${date}|TM:${targetMultiplier}|HASH:${recordHash}`;
}

async function queryStratigraphyDigest(
  { target, format }: z.infer<typeof stratigraphyDigestInputSchema>,
) {
  const records = await getStratigraphyData();
  if (records.length === 0) throw new RangeError("No indexed stratigraphy records available");
  const checkedDate = (date: string): string => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new RangeError("target must contain a valid ISO calendar date");
    }
    return date;
  };
  let indices: number[];
  if (target === "latest") {
    indices = [records.length - 1];
  } else if (/^\d+$/.test(target)) {
    indices = [indexedStratumIndex(target, records)];
  } else {
    const [start, end] = target.split("..").map(checkedDate);
    if (end !== undefined && start > end) throw new RangeError("target range is reversed");
    indices = end === undefined
      ? [indexedStratumIndex(start, records)]
      : records.flatMap((_record, i) => {
        const date = snapshotDate(i, records.length);
        return date >= start && date <= end ? [i] : [];
      });
    if (indices.length > 100) throw new RangeError("target range exceeds 100 records");
  }
  if (indices.length === 0) throw new RangeError("No indexed stratum matches target");
  const formatted = indices.map((index) =>
    formatDigestRecord(records[index], index, records.length, format)
  );
  return target.includes("..") ? formatted : formatted[0];
}

async function queryStratigraphyRange({
  startTarget, endTarget, limit, format,
}: z.infer<typeof stratigraphyRangeInputSchema>) {
  const records = await getStratigraphyData();
  const start = indexedStratumIndex(startTarget, records);
  const end = indexedStratumIndex(endTarget, records);
  if (start > end) throw new RangeError("startTarget must not follow endTarget");
  const formattedRecords = records.slice(start, Math.min(end + 1, start + limit))
    .map((record, offset) => formatDigestRecord(record, start + offset, records.length, format));
  return {
    range: { start: startTarget, end: endTarget },
    count: formattedRecords.length,
    format,
    records: formattedRecords,
  };
}

async function queryStratigraphyDiff(
  { fromTarget, toTarget }: z.infer<typeof stratigraphyDiffInputSchema>,
) {
  const records = await getStratigraphyData();
  const fromIndex = indexedStratumIndex(fromTarget, records);
  const toIndex = indexedStratumIndex(toTarget, records);
  const stratum = (index: number) => ({
    height: snapshotBlock(index, records.length),
    date: snapshotDate(index, records.length),
    target_multiplier: records[index].quantitative_alpha.target_multiplier,
  });
  const from = stratum(fromIndex);
  const to = stratum(toIndex);
  if (from.target_multiplier === 0) {
    throw new RangeError("Cannot calculate percentage change from a zero starting multiplier");
  }
  const multiplierDelta = to.target_multiplier - from.target_multiplier;
  return {
    from,
    to,
    delta: {
      heightDelta: to.height - from.height,
      multiplierDelta,
      percentageChange: `${Number(((multiplierDelta / from.target_multiplier) * 100).toFixed(2))}%`,
      timeSpanDays: (Date.parse(to.date) - Date.parse(from.date)) / DAY_MS,
    },
  };
}

function normalizedAttenuationCaveats(
  input: z.infer<typeof attenuateInputSchema>,
  now: number,
): string[] {
  const normalized = input.caveats.map((raw) => {
    const match = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!match) throw new RangeError("Unsupported attenuation caveat");
    const [, key, value] = match;
    const caveat = `${key}=${value}`;
    if (key === "allowed_tools") {
      const names = value.split(",").map((name) => name.trim());
      if (names.length > 16 || names.some((name) =>
        !/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/.test(name) ||
        (!baseMcpToolDefinitions.some((tool) => tool.name === name) &&
          !Object.hasOwn(legacyToolNames, name))
      )) throw new RangeError("allowed_tools must list registered MCP tools or supported legacy aliases");
      return `allowed_tools=${names.join(",")}`;
    }
    if (key === "time_before" && value.length === 10) {
      const time = Date.parse(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
        throw new RangeError("Invalid time_before UTC date");
      }
    }
    if (
      !/^(?:allowed_path=\/[^\s]*|max_requests=[1-9]\d*|max_target=(?:0|[1-9]\d*)|time_before=(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z))$/.test(caveat)
    ) throw new RangeError("Unsupported attenuation caveat");
    return caveat;
  });
  if (input.ttlSeconds !== undefined) {
    normalized.push(`time_before=${new Date(now + input.ttlSeconds * 1_000).toISOString()}`);
  }
  return normalized;
}

async function withinMcpTargetBound(
  name: string,
  args: unknown,
  maxTarget: number,
): Promise<boolean> {
  name = canonicalToolName(name);
  const records = await getStratigraphyData();
  const heightAt = (index: number) => snapshotBlock(index, records.length);
  if (name === "stratigraphy.get") {
    const selected = await queryStratigraphy(stratigraphyInputSchema.parse(args));
    return selected.length > 0 && selected.every((record) => heightAt(record.day - 1) <= maxTarget);
  }
  if (name === "stratigraphy.get_diff") {
    const { fromTarget, toTarget } = stratigraphyDiffInputSchema.parse(args);
    return [fromTarget, toTarget].every((target) =>
      heightAt(indexedStratumIndex(target, records)) <= maxTarget
    );
  }
  if (name === "stratigraphy.get_range") {
    const { startTarget, endTarget } = stratigraphyRangeInputSchema.parse(args);
    try {
      const start = indexedStratumIndex(startTarget, records);
      const end = indexedStratumIndex(endTarget, records);
      return start <= end &&
        heightAt(start) <= maxTarget && heightAt(end) <= maxTarget;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  }
  if (name === "stratigraphy.get_digest") {
    const { target } = stratigraphyDigestInputSchema.parse(args);
    if (!target.includes("..")) {
      return heightAt(indexedStratumIndex(target, records)) <= maxTarget;
    }
    const [start, end] = target.split("..");
    const selected = records.flatMap((_record, index) => {
      const date = snapshotDate(index, records.length);
      return date >= start && date <= end ? [index] : [];
    });
    return selected.length > 0 && selected.every((index) => heightAt(index) <= maxTarget);
  }
  // Never silently ignore a target caveat on unrelated tools.
  return false;
}

const diffStratumExample = { height: 919856, date: "2026-09-08", target_multiplier: 125.5 };
const diffStratumSchema = {
  type: "object",
  description: "One indexed daily stratum; the height is a deterministic dataset index, not a live Bitcoin block height.",
  examples: [diffStratumExample],
  additionalProperties: false,
  properties: {
    height: field("integer", "Deterministic indexed height for the dataset day.", [919856]),
    date: field("string", "Indexed UTC calendar date.", ["2026-09-08"], { format: "date" }),
    target_multiplier: field("number", "Stored target multiplier; not a measured energy quantity.", [125.5]),
  },
  required: ["height", "date", "target_multiplier"],
};

const baseMcpToolDefinitions = [
  {
    name: "stratigraphy.get",
    title: "Get Bitcoin Stratigraphy",
    description:
      "Fetch indexed daily stratum telemetry records, including quantitative metrics, by date or indexed height (or a bounded range). Use when record contents are required; metrics can optionally narrow returned fields.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Choose recent days, one date/indexed height, or an inclusive date/height range; selector modes cannot be combined. Limit and metrics refine the selected records.",
      examples: [
        { days: 7, limit: 7 },
        { date: "2026-09-09", limit: 1 },
        { blockHeight: 920000, metrics: ["target_multiplier"], limit: 1 },
        { startDate: "2026-08-01", endDate: "2026-08-31", limit: 10 },
        { startBlock: 910000, endBlock: 920000, limit: 25 },
      ],
      additionalProperties: false,
      properties: {
        days: field(
          "integer",
          "Fetch the most recent 1-365 indexed daily records (e.g. 7), capped by limit; cannot combine with date, blockHeight, or range bounds.",
          [7],
          { minimum: 1, maximum: 365 },
        ),
        date: field(
          "string",
          "Select one indexed UTC day (YYYY-MM-DD, e.g. '2026-09-19'); cannot combine with days, blockHeight, or range bounds.",
          ["2026-09-19"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        blockHeight: field(
          "integer",
          "Select one indexed non-negative dataset height (e.g. 850000), not an arbitrary live chain lookup; cannot combine with days, date, or range bounds.",
          [850000],
          { minimum: 0 },
        ),
        metrics: field(
          "array",
          "Unique telemetry metric keys to project into each selected record's quantitative_alpha; omit for all metrics, or choose one or more allowed names.",
          [["target_multiplier"]],
          {
            minItems: 1,
            uniqueItems: true,
            items: field(
              "string",
              "Allowed thermodynamic metric name to include in each returned quantitative_alpha object.",
              ["target_multiplier"],
              { enum: [...thermodynamicMetricNames] },
            ),
          },
        ),
        startDate: field(
          "string",
          "Inclusive lower UTC date bound (YYYY-MM-DD); pair with endDate for a bounded range or use alone for an open range, never with days, date, or blockHeight.",
          ["2026-09-01"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        endDate: field(
          "string",
          "Inclusive upper UTC date bound (YYYY-MM-DD); pair with startDate for a bounded range or use alone for an open range, never with days, date, or blockHeight; must be >= startDate when paired.",
          ["2026-09-18"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        startBlock: field(
          "integer",
          "Inclusive lower indexed block-height bound (non-negative); pair with endBlock for a bounded range or use alone for an open range, never with days, date, or blockHeight.",
          [910000],
          { minimum: 0 },
        ),
        endBlock: field(
          "integer",
          "Inclusive upper indexed block-height bound (non-negative); pair with startBlock for a bounded range or use alone for an open range, never with days, date, or blockHeight; must be >= startBlock when paired.",
          [920000],
          { minimum: 0 },
        ),
        limit: field(
          "integer",
          "Cap records returned by the chosen selector at 1-100 (default 10); does not expand days or range bounds.",
          [10],
          { minimum: 1, maximum: 100, default: 10 },
        ),
      },
      required: [],
    },
    outputSchema: {
      type: "object",
      description: "Bitcoin Stratigraphy telemetry query result.",
      examples: [{ records: [entryJsonSchema.examples[0]] }],
      additionalProperties: false,
      properties: {
        records: field(
          "array",
          "Validated telemetry records matching the requested range.",
          [[entryJsonSchema.examples[0]]],
          { items: entryJsonSchema },
        ),
      },
      required: ["records"],
    },
  },
  {
    name: "stratigraphy.get_digest",
    title: "Get Compressed Stratigraphy Digest",
    description:
      "Fetch a compact digest summary of indexed strata: date, indexed height, target multiplier, and SHA-256 source-record fingerprint. No full telemetry record body is returned; the fingerprint is not a Bitcoin block-header hash or per-record proof.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      description: "Select a daily indexed stratum or bounded date range for compression.",
      examples: [{ target: "latest", format: "compact" }, { target: "2026-09-01..2026-09-09", format: "kv" }],
      additionalProperties: false,
      properties: {
        target: field(
          "string",
          "Indexed Bitcoin height (e.g. '920000'), ISO date, or inclusive ISO date range joined with '..'. Defaults to the latest available dataset entry, not the live Bitcoin tip.",
          ["latest", "920000", "2026-09-09", "2026-09-01..2026-09-09"],
          { pattern: "^(?:latest|(?:0|[1-9]\\d*)|\\d{4}-\\d{2}-\\d{2}(?:\\.\\.\\d{4}-\\d{2}-\\d{2})?)$", default: "latest" },
        ),
        format: field(
          "string",
          "Compression format: minimal returns [height,date,target_multiplier,record_hash]; kv returns {h,ts,tm,hash}; compact returns HEIGHT:...|DATE:...|TM:...|HASH:.... Record hashes are SHA-256 of stored entry fields, not Bitcoin block hashes; no per-record proof is available.",
          ["compact", "minimal", "kv"],
          { enum: ["compact", "minimal", "kv"], default: "compact" },
        ),
      },
      required: [],
    },
    outputSchema: {
      type: "object",
      description: "Compressed digest plus a flag indicating whether source entries carry per-record proofs; a date range returns an array of results in ascending date order.",
      examples: [{ result: "HEIGHT:920000|DATE:2026-09-09|TM:125.83|HASH:0123456789abcdef", proofAvailable: false }],
      additionalProperties: false,
      properties: {
        result: field(
          ["string", "array", "object"],
          "Selected compact string, minimal array or kv object; a date range returns an array of selected results. The hash is a SHA-256 record fingerprint, not a Bitcoin block hash or ZK proof.",
          ["HEIGHT:920000|DATE:2026-09-09|TM:125.83|HASH:0123456789abcdef"],
        ),
        proofAvailable: field(
          "boolean",
          "False for indexed dataset source entries; no per-record ZK proof is stored in this dataset.",
          [false],
          { const: false },
        ),
      },
      required: ["result", "proofAvailable"],
    },
  },
  {
    name: "stratigraphy.get_diff",
    title: "Compare Stratigraphy Strata",
    description:
      "Compute and return parameter delta variances between two distinct stratum heights.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      description: "Compare a required baseline indexed height or UTC date with an optional endpoint; either order is valid and produces signed deltas. latest refers to the latest indexed entry, not the live chain tip.",
      examples: [{ fromTarget: "919856", toTarget: "latest" }, { fromTarget: "2026-09-08", toTarget: "2026-09-09" }],
      additionalProperties: false,
      properties: {
        fromTarget: field(
          "string",
          "Required baseline indexed height (e.g. '850000') or UTC ISO date (e.g. '2026-01-01'); compared with toTarget to calculate signed deltas. Either chronological order is allowed; only indexed entries resolve.",
          ["919856", "2026-09-08"],
          { pattern: diffTargetPattern },
        ),
        toTarget: field(
          "string",
          "Optional comparison indexed height (e.g. '919856'), UTC ISO date (e.g. '2026-09-01'), or 'latest' (default); deltas are toTarget minus fromTarget. 'latest' is the latest dataset entry, not the live Bitcoin tip.",
          ["latest", "920000", "2026-09-09"],
          { pattern: diffEndTargetPattern, default: "latest" },
        ),
      },
      required: ["fromTarget"],
    },
    outputSchema: {
      type: "object",
      description: "Signed difference between two indexed daily records. Percent change is rounded to two decimal places; source data provides a target multiplier, not a direct difficulty or energy measurement.",
      examples: [{
        from: diffStratumExample,
        to: { height: 920000, date: "2026-09-09", target_multiplier: 125.83 },
        delta: { heightDelta: 144, multiplierDelta: 0.33, percentageChange: "0.26%", timeSpanDays: 1 },
      }],
      additionalProperties: false,
      properties: {
        from: diffStratumSchema,
        to: diffStratumSchema,
        delta: {
          type: "object",
          description: "Signed change from the starting indexed entry to the ending entry.",
          examples: [{ heightDelta: 144, multiplierDelta: 0.33, percentageChange: "0.26%", timeSpanDays: 1 }],
          additionalProperties: false,
          properties: {
            heightDelta: field("integer", "Ending indexed height minus starting indexed height.", [144]),
            multiplierDelta: field("number", "Ending stored target multiplier minus starting multiplier.", [0.33]),
            percentageChange: field("string", "Multiplier change divided by starting multiplier, formatted as a percentage to two decimal places.", ["0.26%"]),
            timeSpanDays: field("integer", "Signed number of UTC calendar days between indexed dates.", [1]),
          },
          required: ["heightDelta", "multiplierDelta", "percentageChange", "timeSpanDays"],
        },
      },
      required: ["from", "to", "delta"],
    },
  },
  {
    name: "stratigraphy.get_range",
    title: "Get Stratigraphy Range",
    description:
      "Retrieve a contiguous span of strata entries across a bounded height or time range.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      description: "Select an inclusive, ascending range of indexed daily strata. Bounds must match recorded heights or UTC dates; latest refers to the latest indexed entry, not the live Bitcoin tip.",
      examples: [{ startTarget: "919712", endTarget: "latest", limit: 3, format: "kv" }, { startTarget: "2026-09-08", endTarget: "2026-09-09", format: "minimal" }],
      additionalProperties: false,
      properties: {
        startTarget: field("string", "Required inclusive starting indexed height (e.g. '850000') or UTC ISO date (e.g. '2026-01-01'); must resolve no later than endTarget.", ["919712", "2026-09-07"], { pattern: diffTargetPattern }),
        endTarget: field("string", "Optional inclusive ending indexed height, UTC ISO date, or 'latest' (default: latest indexed entry, not live tip); must resolve no earlier than startTarget.", ["latest", "920000", "2026-09-09"], { pattern: diffEndTargetPattern, default: "latest" }),
        limit: field("number", "Maximum compressed records returned from startTarget toward endTarget, 1-100 (default 50); smaller limits truncate the batch.", [50], { minimum: 1, maximum: 100, default: 50 }),
        format: field("string", "Compression of every returned record: compact (default), minimal, or kv; does not change selected bounds.", ["compact", "minimal", "kv"], { enum: ["compact", "minimal", "kv"], default: "compact" }),
      },
      required: ["startTarget"],
    },
    outputSchema: {
      type: "object",
      description: "Ascending indexed strata between inclusive bounds, truncated at limit. Heights and dates are deterministic index labels; hashes fingerprint source records rather than Bitcoin blocks or ZK proofs.",
      examples: [{
        range: { start: "919856", end: "919856" }, count: 1, format: "compact",
        records: ["HEIGHT:919856|DATE:2026-09-08|TM:125.5|HASH:0123456789abcdef"],
      }],
      additionalProperties: false,
      properties: {
        range: {
          type: "object", description: "Requested bounds, including default latest if omitted.",
          examples: [{ start: "919856", end: "latest" }], additionalProperties: false,
          properties: {
            start: field("string", "Requested starting target.", ["919856"]),
            end: field("string", "Requested ending target.", ["latest"]),
          },
          required: ["start", "end"],
        },
        count: field("integer", "Number of records returned, at most limit.", [2], { minimum: 1, maximum: 100 }),
        format: field("string", "Compression format of each record.", ["compact"], { enum: ["compact", "minimal", "kv"] }),
        records: field("array", "Records in ascending indexed order; compact strings, minimal arrays, or terse key-value objects.", [["HEIGHT:919856|DATE:2026-09-08|TM:125.5|HASH:0123456789abcdef"]], {
          minItems: 1, maxItems: 100,
          items: field(["string", "array", "object"], "One compressed source-record digest.", ["HEIGHT:919856|DATE:2026-09-08|TM:125.5|HASH:0123456789abcdef"]),
        }),
      },
      required: ["range", "count", "format", "records"],
    },
  },
  {
    name: "stratigraphy.list",
    title: "List Stratigraphy Catalog",
    description:
      "List available stratum heights and catalog metadata. Primary discovery tool for valid query targets.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Pass {} to discover catalog bounds before selecting records; any parameter is rejected.",
      examples: [{}],
      additionalProperties: false,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object",
      description: "Discoverable bounds and metrics for the stratigraphy dataset.",
      examples: [{
        totalSnapshots: 422,
        oldestBlock: 859376,
        newestBlock: 920000,
        availableMetrics: [...catalogMetricNames],
        dateBounds: {
          startDate: "2025-07-15",
          endDate: "2026-09-09",
        },
      }],
      additionalProperties: false,
      properties: {
        totalSnapshots: field(
          "integer",
          "Total number of daily stratigraphy snapshots currently available.",
          [422],
          { minimum: 1 },
        ),
        oldestBlock: field(
          "integer",
          "Lowest block height in the deterministic daily snapshot index.",
          [859376],
          { minimum: 0 },
        ),
        newestBlock: field(
          "integer",
          "Highest block height in the deterministic daily snapshot index.",
          [920000],
          { minimum: 0 },
        ),
        availableMetrics: field(
          "array",
          "Telemetry metric paths available in each stratigraphy snapshot.",
          [[...catalogMetricNames]],
          {
            items: field(
              "string",
              "Dot-delimited path of an available telemetry metric.",
              ["quantitative_alpha.target_multiplier"],
            ),
          },
        ),
        dateBounds: {
          type: "object",
          description: "Inclusive ISO date bounds of the available snapshots.",
          examples: [{
            startDate: "2025-07-15",
            endDate: "2026-09-09",
          }],
          additionalProperties: false,
          properties: {
            startDate: field(
              "string",
              "ISO 8601 date of the oldest available snapshot.",
              ["2025-07-15"],
              { format: "date" },
            ),
            endDate: field(
              "string",
              "ISO 8601 date of the newest available snapshot.",
              ["2026-09-09"],
              { format: "date" },
            ),
          },
          required: ["startDate", "endDate"],
        },
      },
      required: [
        "totalSnapshots",
        "oldestBlock",
        "newestBlock",
        "availableMetrics",
        "dateBounds",
      ],
    },
  },
  {
    name: "proof.attenuate",
    title: "Attenuate a Macaroon",
    description:
      "PURPOSE & BOUNDARIES: Derive a narrower child macaroon from an authentic, unexpired parent with tool, target, time, or request restrictions; this does not issue or pay an invoice. USAGE GUIDELINES: Use this for delegated access instead of `payment.get_info`, which only explains pricing and L402 rules. BEHAVIOR & CONSEQUENCES: Free to call, but requires a valid parent token and its existing payment proof for later redemption. Unsupported caveats or invalid parents return an error; inherited restrictions cannot be widened.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      description: "Provide an authentic parent macaroon, an array of restrictions, and optional TTL; child caveats intersect with inherited constraints and no payment invoice is issued.",
      examples: [{ macaroon: "base64url-parent-macaroon", caveats: ["allowed_tools = stratigraphy.get,stratigraphy.get_digest", "max_target = 870000"], ttlSeconds: 3600 }],
      additionalProperties: false,
      properties: {
        macaroon: field("string", "Required authentic, unexpired parent L402 macaroon (1-8192 characters); caveats and ttlSeconds can only narrow its scope.", ["base64url-parent-macaroon"], { minLength: 1, maxLength: 8192 }),
        caveats: field("array", "List of restriction caveats to append (e.g. ['time_before = 2026-12-31', 'max_target = 870000', 'allowed_tools = stratigraphy.get,stratigraphy.get_digest']). Existing allowed_path and max_requests restrictions are also supported.", [["time_before = 2026-12-31", "max_target = 870000", "allowed_tools = stratigraphy.get,stratigraphy.get_digest"]], {
          maxItems: 16,
          items: field("string", "One supported restriction caveat.", ["max_target = 870000"], { minLength: 1, maxLength: 256 }),
        }),
        ttlSeconds: field("number", "Optional positive integer TTL of 1-2592000 seconds (e.g. 3600); appends an expiration caveat without extending the parent's expiry.", [3600], {
          minimum: 1, maximum: 2_592_000,
        }),
      },
      required: ["macaroon", "caveats"],
    },
    outputSchema: {
      type: "object",
      description: "New macaroon and canonical restrictions inherited from the parent plus those added by this call. The child still requires the parent's payment proof for use.",
      examples: [{ status: "attenuated", attenuatedMacaroon: "base64url-child-macaroon", appliedCaveats: ["max_target=870000"], issuedAt: "2026-09-27T21:00:00.000Z" }],
      additionalProperties: false,
      properties: {
        status: field("string", "Successful attenuation status.", ["attenuated"], { const: "attenuated" }),
        attenuatedMacaroon: field("string", "Encoded child subscription macaroon. Treat as a bearer credential.", ["base64url-child-macaroon"]),
        appliedCaveats: field("array", "New canonical caveats appended to the parent; inherited caveats are preserved inside the token.", [["max_target=870000"]], {
          items: field("string", "One appended canonical caveat.", ["max_target=870000"]),
        }),
        issuedAt: field("string", "UTC issuance timestamp.", ["2026-09-27T21:00:00.000Z"], { format: "date-time" }),
      },
      required: ["status", "attenuatedMacaroon", "appliedCaveats", "issuedAt"],
    },
  },
  {
    name: "proof.verify",
    title: "Verify Stratigraphy ZK Proof",
    description:
      "PURPOSE & BOUNDARIES: Verify cryptographic integrity of a Groth16 telemetry or drift zk-SNARK proof without modifying proof registry state; this does not verify OTS records. Telemetry verification is offline, while drift checks consult a Bitcoin block provider. USAGE GUIDELINES: Use `proof.verify` instead of `proof.submit` for read-only validation of existing proofs, and use `proof.submit` exclusively when registering a new proof attestation. Use `proof.ground` when a signed Bitcoin-tip receipt is needed. BEHAVIOR & CONSEQUENCES: Costs 250 sats via HTTP L402 without valid credentials; malformed or mismatched proof inputs fail validation, and drift verification requires a reachable block provider.",
    annotations: proofVerificationToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input arguments containing an encoded Groth16 proof, typed public inputs, a verification-key identifier, and telemetry data.",
      examples: [
        {
          proof: "eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0",
          publicInputs: publicInputsJsonSchema.examples[0],
          verificationKeyId: "sha256:4c095e183ea45a9d",
          data: [{
            block: { height: 920000 },
            observed_at: "2026-09-19T00:00:00.000Z",
            thermodynamic: { target_multiplier: 125.83 },
          }],
        },
        {
          circuit: "zk.drift.v1",
          sessionContextHash: "ab".repeat(32),
          targetBlockHeight: 920000,
          entropyThreshold: 0.75,
          proof: {
            circuit: "zk.drift.v1",
            pi_a: ["1", "2", "1"],
            pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
            pi_c: ["1", "2", "1"],
            publicSignals: ["1", "2"],
            verificationKeyId: "sha256:4c095e183ea45a9d",
          },
          driftScore: 0.25,
          isAligned: true,
          thermodynamicEntropyBits: 0.5,
          blockHash: "ab".repeat(32),
          compactTarget: 486604799,
        },
      ],
      oneOf: [
        {
          type: "object",
          description: "Legacy telemetry-bound Groth16 proof verification input. Example: provide a proof, public inputs, verification key, and telemetry data.",
          examples: [{
            proof: "eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0",
            publicInputs: publicInputsJsonSchema.examples[0],
            verificationKeyId: "sha256:4c095e183ea45a9d",
            data: [{
              block: { height: 920000 },
              observed_at: "2026-09-19T00:00:00.000Z",
              thermodynamic: { target_multiplier: 125.83 },
            }],
          }],
          additionalProperties: false,
          properties: {
            proof: field(
              "string",
              "Base64url-encoded Groth16/Poseidon BN254 proof string without padding.",
              ["eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0"],
              { minLength: 1 },
            ),
            publicInputs: {
              ...publicInputsJsonSchema,
              description:
                "Expected public constants committed by the proof; fields must match the corresponding telemetry payload in data: non-negative blockHeight, non-empty snapshotDigest and thermodynamicHash, non-negative Unix-millisecond timestamp, and non-negative valuationSat. Example: blockHeight 920000 and valuationSat 12583.",
            },
            verificationKeyId: field(
              "string",
              "SHA-256 verification-key identifier string formatted with 'sha256:' prefix.",
              ["sha256:4c095e183ea45a9d"],
              { minLength: 1 },
            ),
            data: field(
              ["object", "array"],
              "Telemetry snapshot payload object or array of objects containing canonical state values.",
              [[{
                block: { height: 920000 },
                observed_at: "2026-09-19T00:00:00.000Z",
                thermodynamic: { target_multiplier: 125.83 },
              }]],
            ),
          },
          required: ["proof", "publicInputs", "verificationKeyId", "data"],
        },
        {
          type: "object",
          description: "Native zk.drift.v1 proof verification input, optionally bound to the complete verifier response. Example: supply the circuit discriminator, session hash, target height, threshold, and proof.",
          examples: [{
            circuit: "zk.drift.v1",
            sessionContextHash: "ab".repeat(32),
            targetBlockHeight: 920000,
            entropyThreshold: 0.75,
            proof: {
              circuit: "zk.drift.v1",
              pi_a: ["1", "2", "1"],
              pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
              pi_c: ["1", "2", "1"],
              publicSignals: ["1", "2"],
              verificationKeyId: "sha256:4c095e183ea45a9d",
            },
            driftScore: 0.25,
            isAligned: true,
            thermodynamicEntropyBits: 0.5,
            blockHash: "ab".repeat(32),
            compactTarget: 486604799,
          }],
          additionalProperties: false,
          properties: {
            circuit: field("string", "Drift proof circuit discriminator.", ["zk.drift.v1"], { const: "zk.drift.v1" }),
            sessionContextHash: field("string", "Hash binding this proof to its agent session context.", ["ab".repeat(32)], { pattern: "^[0-9a-fA-F]{64}$" }),
            targetBlockHeight: field("integer", "Bitcoin block height being evaluated.", [920000], { minimum: 0, maximum: 0xffff_ffff }),
            entropyThreshold: field("number", "Maximum accepted thermodynamic entropy threshold.", [0.75], { minimum: 0, maximum: 1 }),
            proof: {
              type: "object",
              description: "Groth16 proof points, public signals, and verification-key identifier for zk.drift.v1. Example: pi_a, pi_b, pi_c, and public signals.",
              examples: [{
                circuit: "zk.drift.v1",
                pi_a: ["1", "2", "1"],
                pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
                pi_c: ["1", "2", "1"],
                publicSignals: ["1", "2"],
                verificationKeyId: "sha256:4c095e183ea45a9d",
              }],
              additionalProperties: false,
              properties: {
                circuit: field("string", "Proof circuit discriminator.", ["zk.drift.v1"], { const: "zk.drift.v1" }),
                pi_a: {
                  type: "array",
                  description: "Three Groth16 pi_a field elements. Example: [\"1\", \"2\", \"1\"].",
                  examples: [["1", "2", "1"]],
                  minItems: 3,
                  maxItems: 3,
                  items: field("string", "Groth16 pi_a field element.", ["1"], { minLength: 1 }),
                },
                pi_b: {
                  type: "array",
                  description: "Three pairs of Groth16 pi_b field elements. Example: [[\"1\", \"2\"], [\"3\", \"4\"], [\"1\", \"0\"]].",
                  examples: [[["1", "2"], ["3", "4"], ["1", "0"]]],
                  minItems: 3,
                  maxItems: 3,
                  items: {
                    type: "array",
                    description: "A pair of Groth16 pi_b field elements. Example: [\"1\", \"2\"].",
                    examples: [["1", "2"]],
                    minItems: 2,
                    maxItems: 2,
                    items: field("string", "Groth16 pi_b field element.", ["1"], { minLength: 1 }),
                  },
                },
                pi_c: {
                  type: "array",
                  description: "Three Groth16 pi_c field elements. Example: [\"1\", \"2\", \"1\"].",
                  examples: [["1", "2", "1"]],
                  minItems: 3,
                  maxItems: 3,
                  items: field("string", "Groth16 pi_c field element.", ["1"], { minLength: 1 }),
                },
                publicSignals: {
                  type: "array",
                  description: "Public field elements bound to the drift proof. Example: [\"1\", \"2\"].",
                  examples: [["1", "2"]],
                  minItems: 1,
                  items: field("string", "Public signal field element.", ["1"], { minLength: 1 }),
                },
                verificationKeyId: field("string", "Identifier of the verification key to use.", ["sha256:4c095e183ea45a9d"], { minLength: 1 }),
              },
              required: ["circuit", "pi_a", "pi_b", "pi_c", "publicSignals", "verificationKeyId"],
            },
            driftScore: field("number", "Drift score bound to the complete verifier response.", [0.25]),
            isAligned: field("boolean", "Alignment result bound to the complete verifier response.", [true]),
            thermodynamicEntropyBits: field("number", "Thermodynamic entropy value bound to the complete verifier response.", [0.5], { minimum: 0 }),
            blockHash: field("string", "Bitcoin block hash bound to the complete verifier response.", ["ab".repeat(32)], { pattern: "^[0-9a-fA-F]{64}$" }),
            compactTarget: field("integer", "Raw compact target bits bound to the complete verifier response.", [486604799], { minimum: 0, maximum: 0xffff_ffff }),
          },
          required: ["circuit", "sessionContextHash", "targetBlockHeight", "entropyThreshold", "proof"],
        },
      ],
    },
    outputSchema: {
      type: "object",
      description: "Cryptographic proof verification result.",
      examples: [{
        valid: true,
        verifiedAt: "2026-09-19T01:41:36.458Z",
        computationTimeMs: 3.284,
      }],
      additionalProperties: false,
      properties: {
        valid: field(
          "boolean",
          "Whether the proof is valid and bound to the snapshot.",
          [true],
        ),
        verifiedAt: field(
          "string",
          "ISO 8601 UTC time when this verification finished.",
          ["2026-09-19T01:41:36.458Z"],
          { format: "date-time" },
        ),
        computationTimeMs: field(
          "number",
          "Server-side proof verification duration in milliseconds.",
          [3.284],
          { minimum: 0 },
        ),
      },
      required: ["valid", "verifiedAt", "computationTimeMs"],
    },
  },
  {
    name: "proof.get_status",
    title: "Get Proof Status",
    description:
      "Retrieves the verification status, timestamp, and attestation records of a submitted proof hash.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input arguments for querying single proof attestation lifecycle status.",
      examples: [{
        proofHash:
          "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
      }],
      additionalProperties: false,
      properties: {
        proofHash: field(
          "string",
          "Primary proof lifecycle lookup key (64-digit hex with optional 0x prefix or IPFS CID); mutually exclusive with snapshotDigest.",
          [
            "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
          ],
          {
            pattern:
              "^(?:(?:0x)?[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$",
          },
        ),
        snapshotDigest: field(
          "string",
          "Primary snapshot lifecycle lookup key (decimal field digest, 64-digit hex, or IPFS CID); mutually exclusive with proofHash.",
          [
            "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
          ],
          {
            pattern:
              "^(?:\\d+|[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$",
          },
        ),
        receiptHash: field(
          "string",
          "SHA-256 digest from proof.issue_receipt for a signed Bitcoin-tip anchor, not a Groth16 proof; mutually exclusive with proofHash and snapshotDigest.",
          ["ab".repeat(32)],
          { pattern: "^[0-9a-f]{64}$" },
        ),
      },
      required: [],
      oneOf: [
        { required: ["proofHash"] },
        { required: ["snapshotDigest"] },
        { required: ["receiptHash"] },
      ],
    },
    outputSchema: {
      type: "object",
      description:
        "Current verification, cache, Nostr attestation, and mesh quorum state.",
      examples: [{
        status: "verified",
        verifiedAt: "2026-09-19T05:54:39.835Z",
        attestationCount: 3,
        meshQuorum: true,
      }],
      additionalProperties: false,
      properties: {
        status: field(
          "string",
          "Lifecycle state: verified after cryptographic validation, cached on a repeated valid verification, pending while unverified or in progress, or invalid after rejection.",
          ["verified"],
          { enum: ["verified", "cached", "pending", "invalid"] },
        ),
        verifiedAt: field(
          "string",
          "ISO 8601 UTC date string format.",
          ["2026-09-19T05:54:39.835Z"],
          { format: "date-time" },
        ),
        attestationCount: field(
          "integer",
          "Number of Nostr NIP-78 attestations observed on the submitted snapshot.",
          [3],
          { minimum: 0 },
        ),
        meshQuorum: field(
          "boolean",
          "Whether the observed attestation count meets the current mesh quorum threshold.",
          [true],
        ),
      },
      required: ["status", "verifiedAt", "attestationCount", "meshQuorum"],
    },
  },
  {
    name: "proof.get_by_hash",
    title: "Get Proof or Receipt by Hash",
    description:
      "Retrieve a stored historical verification receipt or proof record by hash.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      description: "Supply exactly one of hash or jobId to retrieve an exact retained proof/receipt or lifecycle state. Unknown identifiers return HTTP 404 before payment.",
      examples: [{ hash: `0x${"ab".repeat(32)}` }, { hash: "Qm" + "a".repeat(44) }],
      additionalProperties: false,
      properties: {
        hash: field(
          "string",
          "Required when jobId is absent: proof/receipt 64-hex hash (optional 0x), decimal snapshot digest, IPFS CID, or UUID submission job ID; unknown identifiers return 404.",
          [`0x${"ab".repeat(32)}`, "Qm" + "a".repeat(44)],
          { pattern: "^(?:(?:0x)?[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|\\d{1,77}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$" },
        ),
        jobId: field("string", "UUID returned by proof.submit (e.g. '123e4567-e89b-42d3-a456-426614174000'); use instead of hash, never together.", ["123e4567-e89b-42d3-a456-426614174000"], { format: "uuid" }),
      },
      oneOf: [{ required: ["hash"] }, { required: ["jobId"] }],
    },
    outputSchema: {
      type: "object",
      description: "Exact retained proof or signed receipt, or lifecycle-only status when the original payload is unavailable. No payload is reconstructed from a digest.",
      examples: [{
        kind: "zk-proof", hash: `0x${"ab".repeat(32)}`, status: "verified",
        timestamp: "2026-09-27T21:00:00.000Z",
        proofPayload: { proof: { pi_a: ["1"] }, publicSignals: ["1", "2", "3", "4", "5"] },
        provenanceVerified: false,
      }],
      additionalProperties: false,
      properties: {
        kind: field("string", "Distinguishes ZK proofs, signed receipts, and lifecycle-only status.", ["zk-proof"], { enum: ["zk-proof", "dataset-receipt", "context-receipt", "zk-proof-status"] }),
        hash: field("string", "Canonical proof or receipt hash. CID lookups return the matching receipt hash.", [`0x${"ab".repeat(32)}`]),
        status: field("string", "Current indexed lifecycle status.", ["verified"], { enum: ["verified", "cached", "pending", "invalid"] }),
        timestamp: field("string", "Original submission, verification, or receipt creation time.", ["2026-09-27T21:00:00.000Z"], { format: "date-time" }),
        jobId: field("string", "Submission job identifier when an exact submitted proof payload is retained.", ["123e4567-e89b-42d3-a456-426614174000"], { format: "uuid" }),
        attestationCount: field("integer", "NIP-78 attestation count for lifecycle-only lookups.", [0], { minimum: 0 }),
        meshQuorum: field("boolean", "Whether current mesh quorum is met for lifecycle-only lookups.", [false]),
        provenanceVerified: field("boolean", "Whether this exact signed receipt binds the currently validated dataset strata chain; does not imply Bitcoin OTS confirmation.", [false]),
        provenanceMerkleRoot: field("string", "Merkle root bound in the signed receipt when the current dataset chain matches.", ["ab".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
        otsProof: field("string", "Base64 serialized .ots proof for the bound dataset root bytes when a calendar receipt is available.", ["AQID"], { format: "byte" }),
        otsStatus: field("string", "Calendar-only or independently Bitcoin-verified status of the bound OTS receipt.", ["pending_calendar"], { enum: ["pending_calendar", "bitcoin_block_attested"] }),
        proofPayload: {
          type: "object", description: "Exact retained proof input or signed receipt; do not infer missing snapshot data from a submitted proof.",
          examples: [{ proof: { pi_a: ["1"] }, publicSignals: ["1", "2", "3", "4", "5"] }],
          additionalProperties: true,
          properties: {},
        },
      },
      required: ["kind", "hash", "status", "timestamp", "provenanceVerified"],
    },
  },
  {
    name: "proof.list",
    title: "List Proof Attestations",
    description:
      "PURPOSE & BOUNDARIES: List recent proof attestation states newest-first from bounded process memory, with total before pagination; this does not retrieve full proof payloads. USAGE GUIDELINES: Use this to discover hashes before `proof.get_by_hash`; do not use it to submit proofs (`proof.submit`) or anchor context (`proof.ground`). BEHAVIOR & CONSEQUENCES: Read-only; costs 10 sats via HTTP L402 without valid credentials and shares a 60-requests-per-minute IP limit. Invalid status or pagination filters return JSON-RPC -32602.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Filter bounded proof attestations by lifecycle status, then paginate newest-first with limit and offset; omit all fields for the first default page.",
      examples: [{ limit: 20, offset: 0, status: "verified" }],
      additionalProperties: false,
      properties: {
        limit: field(
          "integer",
          "Pagination window size: maximum number of attestation records to return (integer, 1-100); increase offset by limit for the next page.",
          [20],
          { minimum: 1, maximum: 100, default: 20 },
        ),
        offset: field(
          "integer",
          "Zero-based pagination skip offset (0-1000); increase by limit to page through historical attestations, but multiples of limit are not required.",
          [0],
          { minimum: 0, maximum: 1_000, default: 0 },
        ),
        status: field(
          "string",
          "Filter the attestation index to one lifecycle stage: verified, cached, pending, or invalid.",
          ["verified"],
          { enum: [...proofLifecycleStates] },
        ),
      },
      required: [],
    },
    outputSchema: {
      type: "object",
      description:
        "Recent proof attestation records and the total number matching the optional status filter.",
      examples: [{
        attestations: [{
          proofHash:
            "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
          snapshotDigest: "1534979302823651498736582947365829473658294",
          status: "verified",
          submittedAt: "2026-09-19T06:20:00.000Z",
          attestationCount: 1,
          meshQuorum: true,
        }],
        total: 1,
      }],
      additionalProperties: false,
      properties: {
        attestations: field(
          "array",
          "Recent indexed proof attestations ordered from newest to oldest.",
          [[{
            proofHash:
              "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
            snapshotDigest: "1534979302823651498736582947365829473658294",
            status: "verified",
            submittedAt: "2026-09-19T06:20:00.000Z",
            attestationCount: 1,
            meshQuorum: true,
          }]],
          {
            items: {
              type: "object",
              description:
                "One indexed zk-SNARK proof verification and Nostr attestation record.",
              examples: [{
                proofHash:
                  "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
                snapshotDigest:
                  "1534979302823651498736582947365829473658294",
                status: "verified",
                submittedAt: "2026-09-19T06:20:00.000Z",
                attestationCount: 1,
                meshQuorum: true,
              }],
              additionalProperties: false,
              properties: {
                proofHash: field(
                  "string",
                  "0x-prefixed lowercase hexadecimal SHA-256 digest of the canonical proof.",
                  [
                    "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
                  ],
                ),
                snapshotDigest: field(
                  "string",
                  "Decimal field digest or IPFS CID identifying the indexed telemetry snapshot.",
                  ["1534979302823651498736582947365829473658294"],
                ),
                status: field(
                  "string",
                  "Current lifecycle verification state of the indexed proof.",
                  ["verified"],
                  { enum: [...proofLifecycleStates] },
                ),
                submittedAt: field(
                  "string",
                  "ISO 8601 UTC date string format.",
                  ["2026-09-19T06:20:00.000Z"],
                  { format: "date-time" },
                ),
                attestationCount: field(
                  "integer",
                  "Number of Nostr NIP-78 attestations recorded for this proof.",
                  [1],
                  { minimum: 0 },
                ),
                meshQuorum: field(
                  "boolean",
                  "Whether this proof's attestation count meets the current mesh quorum threshold.",
                  [true],
                ),
              },
              required: [
                "proofHash",
                "snapshotDigest",
                "status",
                "submittedAt",
                "attestationCount",
                "meshQuorum",
              ],
            },
          },
        ),
        total: field(
          "integer",
          "Total number of indexed attestation records matching the optional status filter before the limit is applied.",
          [1],
          { minimum: 0 },
        ),
      },
      required: ["attestations", "total"],
    },
  },
  {
    name: "proof.submit",
    title: "Submit ZK Proof",
    description:
      "PURPOSE & BOUNDARIES: Submit and register a new Groth16 zk-SNARK proof with its five public signals, then attempt a Nostr NIP-78 attestation; this changes proof registry state, but does not append a proof to a Merkle tree. USAGE GUIDELINES: Use `proof.submit` strictly for registering new attestations, and use `proof.verify` instead when validating an existing proof without state mutation. Use `proof.get_by_hash` for retained submissions or `proof.ground` for a Bitcoin-tip receipt. BEHAVIOR & CONSEQUENCES: Costs 250 sats via HTTP L402 without valid credentials; malformed inputs fail validation, invalid proofs are reported, and Nostr publication status may fail separately.",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input payload containing Groth16 proof object and public signals for ingestion and Nostr NIP-78 attestation broadcast.",
      examples: [{
        proof: {
          piA: ["1", "2", "1"],
          piB: [["1", "2"], ["3", "4"], ["1", "0"]],
          piC: ["5", "6", "1"],
        },
        publicSignals: ["920000", "1", "1789776000000", "12583", "1"],
        snapshotDigest: "1",
      }],
      additionalProperties: false,
      properties: {
        proof: {
          type: "object",
          description:
            "Groth16/Poseidon BN254 proof coordinates for non-interactive validation: piA and piC are three decimal-string projective coordinates each, and piB is three pairs of decimal-string extension-field coordinates; for example, piA ['1','2','1'].",
          example: {
            piA: ["1", "2", "1"],
            piB: [["1", "2"], ["3", "4"], ["1", "0"]],
            piC: ["5", "6", "1"],
          },
          examples: [{
            piA: ["1", "2", "1"],
            piB: [["1", "2"], ["3", "4"], ["1", "0"]],
            piC: ["5", "6", "1"],
          }],
          additionalProperties: false,
          properties: {
            piA: field(
              "array",
              "Exactly three decimal-string Groth16 BN254 proof A projective coordinates in order.",
              [["1", "2", "1"]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "string",
                  "Decimal-encoded BN254 scalar-field coordinate in proof point A.",
                  ["10823"],
                  { pattern: "^\\d+$" },
                ),
              },
            ),
            piB: field(
              "array",
              "Exactly three Groth16 BN254 proof B extension-field coordinate pairs, each containing two decimal strings.",
              [[["1", "2"], ["3", "4"], ["1", "0"]]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "array",
                  "BN254 extension-field coordinate pair in proof point B.",
                  [["112", "331"]],
                  {
                    minItems: 2,
                    maxItems: 2,
                    items: field(
                      "string",
                      "Decimal-encoded BN254 extension-field coordinate in proof point B.",
                      ["331"],
                      { pattern: "^\\d+$" },
                    ),
                  },
                ),
              },
            ),
            piC: field(
              "array",
              "Exactly three decimal-string Groth16 BN254 proof C projective coordinates in order.",
              [["5", "6", "1"]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "string",
                  "Decimal-encoded BN254 scalar-field coordinate in proof point C.",
                  ["554"],
                  { pattern: "^\\d+$" },
                ),
              },
            ),
          },
          required: ["piA", "piB", "piC"],
        },
        publicSignals: field(
          "array",
          "Five ordered public inputs—blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest—that must align with the submitted proof coordinates.",
          [["920000", "1", "1789776000000", "12583", "1"]],
          {
            minItems: 5,
            maxItems: 5,
            items: field(
              "string",
              "Decimal-encoded BN254 scalar-field element.",
              ["920000"],
              { pattern: "^\\d+$" },
            ),
          },
        ),
        snapshotDigest: field(
          "string",
          "Decimal field digest or IPFS CID that must equal publicSignals[4] when supplied.",
          ["1"],
          {
            pattern:
              "^(?:\\d+|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$",
          },
        ),
      },
      required: ["proof", "publicSignals"],
    },
    outputSchema: {
      type: "object",
      description:
        "Immediate proof verification, lifecycle ingestion, and Nostr broadcast result.",
      examples: [{
        proofHash:
          "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        status: "verified",
        submittedAt: "2026-09-19T06:20:00.000Z",
        attestationStatus: "broadcast_confirmed",
      }],
      additionalProperties: false,
      properties: {
        proofHash: field(
          "string",
          "0x-prefixed lowercase hexadecimal SHA-256 digest of the canonical proof.",
          [
            "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
          ],
        ),
        jobId: field("string", "Server-generated proof submission job ID for status lookup.", ["123e4567-e89b-42d3-a456-426614174000"], { format: "uuid" }),
        status: field(
          "string",
          "Immediate Groth16 verification result for the submitted proof and public signals.",
          ["verified"],
          { enum: ["verified", "invalid"] },
        ),
        submittedAt: field(
          "string",
          "ISO 8601 UTC date string format.",
          ["2026-09-19T06:20:00.000Z"],
          { format: "date-time" },
        ),
        attestationStatus: field(
          "string",
          "Nostr NIP-78 publication result: broadcast_confirmed, broadcast_failed, not_configured, or not_broadcast_invalid_proof.",
          ["broadcast_confirmed"],
        ),
      },
      required: [
        "proofHash",
        "jobId",
        "status",
        "submittedAt",
        "attestationStatus",
      ],
    },
  },
  {
    name: "proof.ground",
    title: "Ground Agent Context in Bitcoin State",
    description:
      "PURPOSE & BOUNDARIES: Issue a signed Bitcoin-tip receipt for either agent context (contextHash plus agentId) or a dataset CID; this is an anchor, not a ZK or Bitcoin-confirmed OTS proof. USAGE GUIDELINES: Use `proof.verify` for proof verification without anchoring or `proof.get_by_hash` for existing receipts. BEHAVIOR & CONSEQUENCES: Creates a receipt and costs 250 sats via HTTP L402 without valid credentials; the two input modes are exclusive, invalid inputs fail, and tip/provider availability is required.",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Epistemic context grounding request for a directly returned signed anchor receipt after MCP settlement.",
      examples: [{
        contextHash:
          "4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f",
        agentId: "research-agent-7",
        metadata: { topic: "difficulty-adjustment" },
      }],
      additionalProperties: false,
      properties: {
        contextHash: field(
          "string",
          "64-character hexadecimal SHA-256 digest binding the agent's prompt or execution state to the current block tip; normalized to lowercase.",
          ["4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f"],
          { pattern: "^[0-9a-fA-F]{64}$", minLength: 64, maxLength: 64 },
        ),
        agentId: field(
          "string",
          "Unique agent instance identifier named in the signed attestation receipt; trimmed to 1-256 characters.",
          ["research-agent-7"],
          { minLength: 1, maxLength: 256 },
        ),
        metadata: field(
          "object",
          "Optional non-secret JSON key-value metadata bound to the signed receipt; serialized size must not exceed 16 KiB.",
          [{ topic: "difficulty-adjustment" }],
          { additionalProperties: true },
        ),
      },
      required: ["contextHash", "agentId"],
    },
    outputSchema: {
      type: "object",
      description: "Signed epistemic anchor receipt grounded against a Bitcoin tip.",
      examples: [{
        receipt: {
          receiptSchema: "bitcoin-stratigraphy/epistemic-anchor/v1",
          contextHash:
            "4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f",
          agentId: "research-agent-7",
          blockHeight: 920001,
          blockHash: "ab".repeat(32),
          merkleRoot: "cd".repeat(32),
          timestamp: 1789776000000,
          schema: "bitcoin-stratigraphy/cryptographic-attestation/v1",
          payload: { contextHash: "4f".repeat(32) },
          proof: { algorithm: "sha256", merkleRoot: "cd".repeat(32) },
          signature: { protocol: "nostr", nip: 78 },
          nostrSignature: { protocol: "nostr", nip: 78 },
        },
      }],
      additionalProperties: false,
      properties: {
        receipt: field(
          "object",
          "Full signed receipt; send unchanged to POST /api/v1/zk/verify as attestation.",
          [{
            receiptSchema: "bitcoin-stratigraphy/epistemic-anchor/v1",
            contextHash:
              "4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f",
            agentId: "research-agent-7",
            blockHeight: 920001,
            blockHash: "ab".repeat(32),
            merkleRoot: "cd".repeat(32),
            timestamp: 1789776000000,
            schema: "bitcoin-stratigraphy/cryptographic-attestation/v1",
            payload: { contextHash: "4f".repeat(32) },
            proof: { algorithm: "sha256", merkleRoot: "cd".repeat(32) },
            signature: { protocol: "nostr", nip: 78 },
            nostrSignature: { protocol: "nostr", nip: 78 },
          }],
          {
            additionalProperties: true,
            properties: {
              receiptSchema: field("string", "Epistemic anchor receipt schema.", ["bitcoin-stratigraphy/epistemic-anchor/v1"]),
              contextHash: field("string", "Lowercase SHA-256 context digest.", ["4f".repeat(32)]),
              agentId: field("string", "Trimmed caller identifier.", ["research-agent-7"]),
              blockHeight: field("integer", "Grounding Bitcoin block height.", [920001]),
              blockHash: field("string", "Grounding Bitcoin block hash.", ["ab".repeat(32)]),
              merkleRoot: field("string", "Signed payload Merkle root.", ["cd".repeat(32)]),
              timestamp: field("integer", "Grounding time in Unix milliseconds.", [1789776000000]),
              schema: field("string", "Cryptographic attestation schema.", ["bitcoin-stratigraphy/cryptographic-attestation/v1"]),
              payload: field("object", "Context and Bitcoin state committed by the signature.", [{ contextHash: "4f".repeat(32) }], { additionalProperties: true }),
              proof: field("object", "SHA-256 payload and Merkle commitment.", [{ algorithm: "sha256", merkleRoot: "cd".repeat(32) }], { additionalProperties: true }),
              signature: field("object", "Nostr NIP-78 event signing the commitment.", [{ protocol: "nostr", nip: 78 }], { additionalProperties: true }),
              nostrSignature: field("object", "Alias for the signed NIP-78 event.", [{ protocol: "nostr", nip: 78 }], { additionalProperties: true }),
            },
            required: ["receiptSchema", "contextHash", "agentId", "blockHeight", "blockHash", "merkleRoot", "timestamp", "schema", "payload", "proof", "signature", "nostrSignature"],
          },
        ),
      },
      required: ["receipt"],
    },
  },
  {
    name: "proof.issue_receipt",
    title: "Anchor a Dataset to the Bitcoin Tip",
    description:
      "Issue a signed Bitcoin-tip receipt binding an IPFS dataset CID or hash to the active block height. Use this tool ONLY to anchor static dataset payloads for off-chain verification. Do NOT use for live agent execution state grounding (use `proof.ground`), ZK proof submission (use `proof.submit`), or checking attestation status (use `proof.get_status`).",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Dataset identifier and optional Nostr provenance to bind to a signed Bitcoin-tip anchor.",
      examples: [{
        cid: "bafybeigdyrzt5sfp7udm7hu76uhka4lyer5y2wjy7zt6fw7v6r2w4x3ydq",
        nostrEventId: "ab".repeat(32),
        context: { source: "dataset" },
      }],
      additionalProperties: false,
      properties: {
        cid: {
          type: "string",
          description: "Target IPFS CID or 32-byte hex dataset hash anchored directly to the live Bitcoin block height. Example: a 64-character lowercase hex digest.",
          example: "ab".repeat(32),
          examples: ["ab".repeat(32)],
          pattern: "^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|(?:0x)?[0-9a-fA-F]{64})$",
          maxLength: 256,
        },
        nostrEventId: {
          type: "string",
          description: "Optional Nostr event ID linked into the signed receipt payload to bind off-chain publications to the block tip. Example: a 64-character lowercase hex event ID.",
          example: "ab".repeat(32),
          examples: ["ab".repeat(32)],
          pattern: "^[0-9a-fA-F]{64}$",
        },
        context: {
          type: "object",
          description: "Optional JSON metadata object bound into the signed receipt tuple for additional execution context. Example: {\"source\":\"dataset\"}.",
          example: { source: "dataset" },
          examples: [{ source: "dataset" }],
          additionalProperties: true,
        },
      },
      required: ["cid"],
    },
    outputSchema: {
      type: "object",
      description: "Signed dataset anchor; receiptHash is a tuple digest and proofPayload is a full verifiable signed receipt, not a ZK proof.",
      examples: [{
        receiptHash: "cd".repeat(32),
        blockTip: 920001,
        blockHash: "ab".repeat(32),
        ipfsCid: "ef".repeat(32),
        nostrEventId: "ab".repeat(32),
        attestation: {
          type: "Signed-Bitcoin-Tip-Anchor",
          proofPayload: JSON.stringify({ receiptSchema: "bitcoin-stratigraphy/epistemic-anchor/v1", contextHash: "cd".repeat(32) }),
          verified: true,
        },
        timestamp: "2026-09-19T01:41:36.458Z",
      }],
      additionalProperties: false,
      properties: {
        receiptHash: field("string", "SHA-256 hex digest of the JSON tuple [cid, blockHash, blockTip, nostrEventId or empty string, ISO timestamp], signed as the receipt contextHash.", ["cd".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
        blockTip: field("integer", "Current Bitcoin block height verified at receipt issuance.", [920001], { minimum: 1 }),
        blockHash: field("string", "Current Bitcoin block hash included in the signed payload.", ["ab".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
        ipfsCid: field("string", "Original dataset CID or hex hash included in the signed payload.", ["ef".repeat(32)]),
        nostrEventId: field("string", "Optional caller-supplied Nostr event ID included in the signed payload; not a publication result.", ["ab".repeat(32)], { pattern: "^[0-9a-fA-F]{64}$" }),
        attestation: {
          type: "object",
          description: "Self-verified signed Bitcoin-tip attestation; not a Groth16 proof or a PoW validity proof.",
          examples: [{
            type: "Signed-Bitcoin-Tip-Anchor",
            proofPayload: JSON.stringify({ receiptSchema: "bitcoin-stratigraphy/epistemic-anchor/v1", contextHash: "cd".repeat(32) }),
            verified: true,
          }],
          additionalProperties: false,
          properties: {
            type: field("string", "Signed Bitcoin-tip anchor type, not a ZK scheme.", ["Signed-Bitcoin-Tip-Anchor"], { const: "Signed-Bitcoin-Tip-Anchor" }),
            proofPayload: field("string", "JSON-serialized complete signed receipt; parse and send as attestation to POST /api/v1/zk/verify.", [JSON.stringify({ receiptSchema: "bitcoin-stratigraphy/epistemic-anchor/v1" })]),
            verified: field("boolean", "Whether the signed receipt passed self-verification before return; not a Bitcoin PoW or ZK proof verification.", [true]),
          },
          required: ["type", "proofPayload", "verified"],
        },
        timestamp: field("string", "ISO 8601 UTC receipt issuance time included in the signed tuple.", ["2026-09-19T01:41:36.458Z"], { format: "date-time" }),
      },
      required: ["receiptHash", "blockTip", "blockHash", "ipfsCid", "attestation", "timestamp"],
    },
  },
  {
    name: "payment.get_info",
    title: "Get MCP Payment Information",
    description:
      `Retrieve configured MCP pricing, Lightning invoice rules, and optional Base USDC x402 terms.

- PURPOSE & BOUNDARIES: Inspect cost requirements and active auth schemes across the tool catalog. Use \`payment.get_info\` instead of calling paid tools blindly when checking pricing upfront.
- USAGE GUIDELINES: Use \`payment.get_info\` instead of \`proof.attenuate\` when discovering required sat fees or active auth schemes across tools. Do NOT use \`payment.get_info\` to settle payments or issue invoices (settlement occurs dynamically via HTTP payment challenge headers on target paid calls), and do NOT use it to restrict Macaroons (use \`proof.attenuate\` instead).
- BEHAVIOR & CONSEQUENCES: Free, read-only, and idempotent. Returns Lightning rates and invoice expiry limits; Base USDC x402 terms appear only when authenticated settlement is ready. Passing an unknown \`toolName\` returns a validation error.`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      description: "Pass an optional canonical toolName to narrow the returned price map; omit it for all advertised prices. This free request does not issue an invoice.",
      examples: [{}, { toolName: "stratigraphy.get_digest" }],
      additionalProperties: false,
      properties: {
        toolName: field("string", "Optional case-sensitive canonical MCP tool identifier (e.g., 'stratigraphy.get_digest' or 'proof.verify'); supported legacy aliases are also accepted and resolve to canonical names. When provided, filters output to return pricing specifically for that single tool. When omitted, returns the full pricing map across all registered catalog tools. Must match an exact registered tool name or supported legacy alias.", ["stratigraphy.get_digest"], { minLength: 1 }),
      },
      required: [],
    },
    outputSchema: {
      type: "object",
      description: "Configured MCP prices in sats (zero denotes a free tool), Lightning L402 rules, and optional Base USDC x402 terms. No live invoice is created by this tool.",
      examples: [{
        standardInvoiceSats: 250, perToolSats: { "stratigraphy.get_digest": 250 },
        acceptedPaymentMethods: ["Lightning L402"], invoiceExpirySeconds: 3600,
        challenge: { httpStatus: 402, header: "WWW-Authenticate", fields: ["macaroon", "invoice", "payment_hash", "amount_sats"] },
        activeAuthSchemes: ["L402"],
        macaroonRequirements: { authorizationHeader: "L402 <macaroon>:<preimage>", scope: "exact MCP tool path", maxRequests: 1 },
      }],
      additionalProperties: false,
      properties: {
        standardInvoiceSats: field("integer", "Standard paid MCP execution price. Catalog and status lookups may cost less; free tools cost zero.", [250], { const: 250 }),
        perToolSats: {
          type: "object", description: "Current advertised canonical tool prices in sats; optional toolName narrows this map.",
          examples: [{ "stratigraphy.get_digest": 250 }],
          additionalProperties: { type: "integer", minimum: 0 },
          properties: {},
        },
        acceptedPaymentMethods: field("array", "Supported MCP payment method.", [["Lightning L402"]], { items: field("string", "Lightning invoice with L402 payment proof.", ["Lightning L402"]) }),
        invoiceExpirySeconds: field("integer", "Default expiry for both the issued Lightning invoice and its path-bound macaroon.", [3600], { minimum: 1 }),
        challenge: {
          type: "object", description: "HTTP payment challenge and response fields.",
          examples: [{ httpStatus: 402, header: "WWW-Authenticate", fields: ["macaroon", "invoice", "payment_hash", "amount_sats"] }],
          additionalProperties: false,
          properties: {
            httpStatus: field("integer", "HTTP status for a payment challenge.", [402], { const: 402 }),
            header: field("string", "Header carrying the L402 macaroon and invoice.", ["WWW-Authenticate"]),
            fields: field("array", "JSON challenge body fields.", [["macaroon", "invoice", "payment_hash", "amount_sats"]], { items: field("string", "Challenge field name.", ["invoice"]) }),
          },
          required: ["httpStatus", "header", "fields"],
        },
        activeAuthSchemes: field("array", "Authentication scheme for paid MCP calls; free discovery and payment.get_info require none.", [["L402"]], { items: field("string", "MCP paid-call scheme.", ["L402"]) }),
        x402: {
          type: "object",
          description: "Base mainnet USDC x402 exact terms; present only when authenticated CDP settlement is configured.",
          examples: [{
            network: "eip155:8453", scheme: "exact",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "1000", payTo: "0x7a4183ce5b9989833bb33133dcbb8efd6a84e775",
          }],
          additionalProperties: false,
          properties: {
            network: field("string", "x402 CAIP-2 network.", ["eip155:8453"]),
            scheme: field("string", "x402 scheme.", ["exact"]),
            asset: field("string", "USDC token contract.", ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]),
            amount: field("string", "Atomic USDC units per paid call.", ["1000"]),
            payTo: field("string", "Payment recipient.", ["0x7a4183ce5b9989833bb33133dcbb8efd6a84e775"]),
          },
          required: ["network", "scheme", "asset", "amount", "payTo"],
        },
        macaroonRequirements: {
          type: "object", description: "A valid payment proof must match the bound invoice, provider, amount, path, expiry and single-use restriction. proof.attenuate is free but requires a valid parent token.",
          examples: [{ authorizationHeader: "L402 <macaroon>:<preimage>", scope: "exact MCP tool path", maxRequests: 1 }],
          additionalProperties: false,
          properties: {
            authorizationHeader: field("string", "Authorization header form for redeeming a settled challenge.", ["L402 <macaroon>:<preimage>"]),
            scope: field("string", "Issued macaroons are bound to the challenged MCP tool path.", ["exact MCP tool path"]),
            maxRequests: field("integer", "Each issued paid-tool macaroon is single-use.", [1], { const: 1 }),
          },
          required: ["authorizationHeader", "scope", "maxRequests"],
        },
      },
      required: ["standardInvoiceSats", "perToolSats", "acceptedPaymentMethods", "invoiceExpirySeconds", "challenge", "activeAuthSchemes", "macaroonRequirements"],
    },
  },
  {
    name: "mesh.get_status",
    title: "Get Mesh Status",
    description:
      "PURPOSE & BOUNDARIES: Inspect P2P peer counts, topology health, cross-validation rate, propagation latency, and quorum; inbound subscription state is not exposed. USAGE GUIDELINES: Use this instead of `mesh.broadcast` to observe mesh availability without distributing a snapshot. BEHAVIOR & CONSEQUENCES: Free and read-only; results depend on external peers and may change between calls. Unexpected input returns a validation error. Note: Direct mesh peer inspection and administration are intentionally unsupported by design to maintain strict minimal-node security. Peer administration and node topology edits are intentionally omitted by design; node peering and consensus are fully automated.",
    annotations: meshStatusToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Pass {} for current peer health and quorum; extra arguments are rejected and inbound subscription state is not tracked.",
      examples: [{}],
      additionalProperties: false,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object",
      description: "Current peer mesh topology and validation health.",
      examples: [{
        nodePubkey: meshStatusJsonProperties.nodePubkey.examples[0],
        activePeerCount: 3,
        configuredPeerCount: 2,
        topologyHealth: "healthy",
        crossValidationSuccessRate: 0.98,
        averagePropagationLatencyMs: 42.7,
        quorumThreshold: 2,
      }],
      additionalProperties: false,
      properties: meshStatusJsonProperties,
      required: Object.keys(meshStatusJsonProperties),
    },
  },
  {
    name: "mesh.broadcast",
    title: "Broadcast Telemetry Snapshot to Mesh",
    description:
      "PURPOSE & BOUNDARIES: Sign a stored daily telemetry snapshot selected by date and distribute it to pinned mesh peers for cross-validation; arbitrary payloads or inbound peer sync publication are not supported. USAGE GUIDELINES: Use this instead of `mesh.get_status` only when sending a snapshot for peer acknowledgment. BEHAVIOR & CONSEQUENCES: Side-effecting and costs 250 sats via HTTP L402 without valid credentials; missing records, invalid agent events, unavailable peers, or failed quorum return errors.",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Select a stored telemetry record for fresh signing and active mesh distribution.",
      examples: [{ signalType: "telemetry_snapshot", payload: { date: "2026-09-09" } }],
      additionalProperties: false,
      properties: {
        signalType: field(
          "string",
          "Enforces the broadcast event schema; must be telemetry_snapshot to trigger peer validation, not an arbitrary signal.",
          ["telemetry_snapshot"],
          { enum: ["telemetry_snapshot"] },
        ),
        payload: {
          type: "object",
          description: "UTC date selector for an existing telemetry record submitted for peer attestation, not a caller-supplied record object; for example, {\"date\":\"2026-09-09\"}.",
          examples: [{ date: "2026-09-09" }],
          additionalProperties: false,
          properties: {
            date: field(
              "string",
              "Required UTC date of an existing indexed record (YYYY-MM-DD, e.g. '2026-09-09'); selects the stored snapshot signed for peer validation, not a caller-supplied payload.",
              ["2026-09-09"],
              { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            ),
          },
          required: ["date"],
        },
        agentEvent: {
          type: "object",
          description: "Optional NIP-01 kind 20079 signature over JSON.stringify({networkId,date}) for this exact date selector. The signer must have a trusted mesh attestation. Example: a complete signed event with a matching date.",
          examples: [{ id: "ab".repeat(32), pubkey: "cd".repeat(32), sig: "ef".repeat(64), kind: 20079, created_at: 1790000000, tags: [], content: '{"networkId":"bitcoin-stratigraphy-mainnet-v1","date":"2026-09-09"}' }],
          additionalProperties: false,
          properties: {
            id: field("string", "NIP-01 event hash.", ["ab".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
            pubkey: field("string", "Signing agent Nostr pubkey.", ["cd".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
            sig: field("string", "Schnorr signature over the NIP-01 event.", ["ef".repeat(64)], { pattern: "^[0-9a-f]{128}$" }),
            kind: field("integer", "Agent session event kind.", [20079], { const: 20079 }),
            created_at: field("integer", "Unix event timestamp in seconds.", [1790000000]),
            tags: {
              type: "array", description: "NIP-01 string tag arrays. Example: [].", examples: [[]],
              items: {
                type: "array", description: "One NIP-01 tag. Example: [\"t\",\"session\"].", examples: [["t", "session"]],
                items: field("string", "One string tag element.", ["session"]),
              },
            },
            content: field("string", "Exact JSON.stringify({networkId,date}) session binding.", ['{"networkId":"bitcoin-stratigraphy-mainnet-v1","date":"2026-09-09"}']),
          },
          required: ["id", "pubkey", "sig", "kind", "created_at", "tags", "content"],
        },
      },
      required: ["signalType", "payload"],
    },
    outputSchema: {
      type: "object",
      description: "Successful peer cross-validation receipt for the selected signed snapshot.",
      examples: [{
        signalType: "telemetry_snapshot",
        date: "2026-09-09",
        snapshotDigest: "ab".repeat(32),
        peerAttestations: 1,
        quorumThreshold: 2,
        merkleRoot: "cd".repeat(32),
        networkId: "bitcoin-stratigraphy-mainnet-v1",
      }],
      additionalProperties: false,
      properties: {
        signalType: field("string", "Signal distributed to configured peers.", ["telemetry_snapshot"], { enum: ["telemetry_snapshot"] }),
        date: field("string", "UTC date of the distributed telemetry record.", ["2026-09-09"], { format: "date" }),
        snapshotDigest: field("string", "SHA-256 digest of the canonical mesh-encoded signed snapshot.", ["ab".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
        peerAttestations: field("integer", "Number of remote pinned peers whose signatures were verified; excludes this node.", [1], { minimum: 1 }),
        quorumThreshold: field("integer", "Required total attestation count, including this node.", [2], { minimum: 1 }),
        merkleRoot: field("string", "Merkle root of local and peer attestation event identifiers.", ["cd".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
        networkId: field("string", "Mesh network identifier committed in peer attestations.", ["bitcoin-stratigraphy-mainnet-v1"]),
        agentPubkey: field("string", "Present only when an agent-signed session was verified and accepted by the peer mesh.", ["cd".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
      },
      required: ["signalType", "date", "snapshotDigest", "peerAttestations", "quorumThreshold", "merkleRoot", "networkId"],
    },
  },
];

const immutabilityNote =
  "Note: Stratigraphy records and zk-SNARK proofs are append-only and immutable by design; update and delete operations are intentionally non-existent.";
const otsVerificationMetadata = {
    inputSchema: {
      type: "object",
      description: "Serialized OTS receipt and the exact 32-byte SHA-256 digest it stamps.",
      examples: [{ otsProof: "AQID", targetHash: "ab".repeat(32) }],
      additionalProperties: false,
      properties: {
        otsProof: field("string", "Canonical base64 or even-length hex serialized .ots receipt (maximum 512 KiB decoded).", ["AQID"], { minLength: 1, maxLength: 1_048_576 }),
        targetHash: field("string", "64-character SHA-256 digest recorded by the receipt; not a Bitcoin header hash.", ["ab".repeat(32)], { pattern: "^[0-9a-fA-F]{64}$" }),
      },
      required: ["otsProof", "targetHash"],
    },
    outputSchema: {
      type: "object",
      description: "OTS verification outcome. Bitcoin height and header hash are null unless a matching Bitcoin block attestation was verified.",
      examples: [{ valid: true, status: "bitcoin_block_attested", blockHeight: 920000, bitcoinHeaderHash: "ab".repeat(32) }],
      additionalProperties: false,
      properties: {
        valid: field("boolean", "True only for a digest-matching, Bitcoin-attested OTS record with a valid chain-header lookup.", [true]),
        status: field("string", "Whether the OTS record is Bitcoin-attested; calendar-only receipts are unverified.", ["bitcoin_block_attested"], { enum: ["bitcoin_block_attested", "unverified"] }),
        blockHeight: field(["integer", "null"], "Bitcoin attestation height, or null if not verified.", [920000]),
        bitcoinHeaderHash: field(["string", "null"], "Canonical Bitcoin block header hash at the attested height, or null if not verified.", ["ab".repeat(32)]),
      },
      required: ["valid", "status", "blockHeight", "bitcoinHeaderHash"],
    },
};
const paymentSettlementMetadata = {
    inputSchema: {
      type: "object",
      description: "Payment identifier and one payment proof; the matching signed L402 or x402 credential must be supplied in HTTP headers.",
      examples: [{ paymentHash: "ab".repeat(32), preimage: "cd".repeat(32) }, { paymentHash: "0x" + "ab".repeat(32), txHash: "0x" + "ab".repeat(32) }],
      additionalProperties: false,
      properties: {
        paymentHash: field("string", "L402 SHA-256 invoice hash, or Base tx hash when using x402.", ["ab".repeat(32)], { pattern: "^(0x)?[0-9a-fA-F]{64}$" }),
        preimage: field("string", "L402 32-byte hex preimage; also send Authorization: L402 <server-issued macaroon>:<preimage>.", ["cd".repeat(32)], { pattern: "^[0-9a-fA-F]{64}$" }),
        txHash: field("string", "Base mainnet transaction hash, accepted only after facilitator settlement of PAYMENT-SIGNATURE.", ["0x" + "ab".repeat(32)], { pattern: "^0x[0-9a-fA-F]{64}$" }),
      },
      required: ["paymentHash"],
      oneOf: [{ required: ["preimage"] }, { required: ["txHash"] }],
    },
    outputSchema: {
      type: "object",
      description: "Non-transferable verification claims; never a newly issued payment capability.",
      examples: [{ verified: true, settlementToken: { scheme: "L402", paymentHash: "ab".repeat(32), scope: "/mcp/tools/stratigraphy.get", settledAt: "2026-09-28T12:00:00.000Z" } }],
      additionalProperties: false,
      properties: {
        verified: field("boolean", "Whether the signed, server-bound payment was verified or settled.", [true]),
        settlementToken: {
          type: ["object", "null"],
          description: "Verified payment claims, not a bearer token or a grant of tool access.",
          examples: [{ scheme: "L402", paymentHash: "ab".repeat(32), scope: "/mcp/tools/stratigraphy.get", settledAt: "2026-09-28T12:00:00.000Z" }],
          additionalProperties: false,
          properties: {
            scheme: field("string", "Settlement rail.", ["L402"], { enum: ["L402", "x402"] }),
            paymentHash: field("string", "Verified Lightning invoice hash or Base transaction hash.", ["ab".repeat(32)]),
            scope: field("string", "Original L402 tool path or x402 MCP resource path; this receipt cannot expand access.", ["/mcp/tools/stratigraphy.get"]),
            settledAt: field("string", "Settlement verification time as ISO 8601 UTC.", ["2026-09-28T12:00:00.000Z"], { format: "date-time" }),
          },
          required: ["scheme", "paymentHash", "scope", "settledAt"],
        },
      },
      required: ["verified", "settlementToken"],
    },
};
const exactDescriptionToolNames = new Set([
  "stratigraphy.get",
  "stratigraphy.get_digest",
  "stratigraphy.get_diff",
  "stratigraphy.get_range",
  "stratigraphy.list",
  "proof.attenuate",
  "proof.get_by_hash",
  "proof.ground",
  "proof.verify",
  "proof.submit",
  "mesh.get_status",
  "mesh.broadcast",
]);
const datasetReceiptDefinition = baseMcpToolDefinitions.find((tool) => tool.name === "proof.issue_receipt")!;
const mcpToolDefinitions = [...baseMcpToolDefinitions
  .filter((tool) => tool.name !== "proof.get_status" && tool.name !== "proof.issue_receipt")
  .map((tool) => {
    const merged = tool.name === "proof.verify"
      ? {
          ...tool,
          title: "Verify Groth16 or OpenTimestamps Proof",
          description: "Execute active cryptographic ZK-SNARK or OpenTimestamps verification on a proof payload. This tool verifies supplied proofs; it does not revoke proofs or refresh verification keys. Verification status and retained payloads are bounded, not permanent attestations.",
          annotations: { ...tool.annotations, openWorldHint: true },
          inputSchema: {
            type: "object", description: "Select groth16 (default) or ots, supplying only fields for the selected verification path.",
            examples: [...tool.inputSchema.examples, { proofType: "ots", otsProof: "AQID", targetHash: "ab".repeat(32) }],
            oneOf: [
              ...(tool.inputSchema as { oneOf: Array<{ properties: Record<string, unknown> }> }).oneOf.map((branch) => ({
                ...branch,
                properties: {
                  ...branch.properties,
                  proofType: field("string", "Groth16 verification (default).", ["groth16"], { const: "groth16", default: "groth16" }),
                },
              })),
              {
                ...otsVerificationMetadata.inputSchema,
                description: "OTS mode requires proofType ots, a complete receipt, and its SHA-256 file digest.",
                properties: {
                  proofType: field("string", "OpenTimestamps Bitcoin verification.", ["ots"], { const: "ots" }),
                  ...otsVerificationMetadata.inputSchema.properties,
                },
                required: ["proofType", "otsProof", "targetHash"],
              },
            ],
          },
          outputSchema: {
            ...tool.outputSchema,
            description: "Groth16 verification timing or OTS Bitcoin attestation result, depending on proofType.",
            examples: [...tool.outputSchema.examples, ...otsVerificationMetadata.outputSchema.examples],
            properties: { ...tool.outputSchema.properties, ...otsVerificationMetadata.outputSchema.properties },
            required: ["valid"],
            oneOf: [
              { required: ["verifiedAt", "computationTimeMs"] },
              { required: ["status", "blockHeight", "bitcoinHeaderHash"] },
            ],
          },
        }
      : tool.name === "payment.get_info"
      ? {
          ...tool,
          title: "Query MCP Prices or Verify Payment Settlement",
          description: "Query MCP pricing parameters and verify L402 payment status. Macaroons and Lightning invoices are issued via HTTP 402 challenges and expire; an operator-only HTTP endpoint can revoke macaroons. No MCP key-refresh or token-revocation tool is exposed.",
          annotations: { ...tool.annotations, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
          inputSchema: {
            type: "object",
            description: "Query pricing (default) or settle a matching authenticated Lightning or Base payment.",
            examples: [{}, { action: "settle", paymentHash: "ab".repeat(32), preimage: "cd".repeat(32) }],
            additionalProperties: false,
            properties: {
              ...tool.inputSchema.properties,
              action: field("string", "query (default) discovers prices; settle verifies authenticated payment.", ["query"], { enum: ["query", "settle"], default: "query" }),
              ...paymentSettlementMetadata.inputSchema.properties,
            },
            required: [],
            oneOf: [
              {
                type: "object", additionalProperties: false,
                properties: {
                  ...tool.inputSchema.properties,
                  action: field("string", "Pricing query (default).", ["query"], { const: "query", default: "query" }),
                },
              },
              {
                ...paymentSettlementMetadata.inputSchema,
                properties: {
                  action: field("string", "Verify or execute payment settlement.", ["settle"], { const: "settle" }),
                  ...paymentSettlementMetadata.inputSchema.properties,
                },
                required: ["action", "paymentHash"],
              },
            ],
          },
          outputSchema: {
            ...tool.outputSchema,
            description: "Pricing details for query, or non-transferable payment verification claims for settle.",
            examples: [...tool.outputSchema.examples, ...paymentSettlementMetadata.outputSchema.examples],
            properties: { ...tool.outputSchema.properties, ...paymentSettlementMetadata.outputSchema.properties },
            required: [],
            oneOf: [
              { required: tool.outputSchema.required },
              { required: ["verified", "settlementToken"] },
            ],
          },
        }
      : tool.name === "proof.ground"
      ? {
          ...tool,
          inputSchema: {
            type: "object",
            description: "Provide contextHash and agentId together for live agent context, or cid for a dataset anchor; these two modes are exclusive. Optional metadata applies to context mode; optional nostrEventId and context apply to dataset mode.",
            examples: [...tool.inputSchema.examples, ...datasetReceiptDefinition.inputSchema.examples],
            additionalProperties: false,
            properties: { ...tool.inputSchema.properties, ...datasetReceiptDefinition.inputSchema.properties },
            oneOf: [{ required: ["contextHash", "agentId"] }, { required: ["cid"] }],
          },
          outputSchema: {
            type: "object",
            description: "Signed context or dataset receipt anchored to the current Bitcoin tip.",
            examples: [
              { receipt: (tool.outputSchema.examples[0] as { receipt: unknown }).receipt, provenanceVerified: true },
              { receipt: datasetReceiptDefinition.outputSchema.examples[0], provenanceVerified: true },
            ],
            additionalProperties: false,
            properties: {
              receipt: {
                type: "object",
                description: "Full signed context receipt or signed dataset receipt wrapper. Example: a signed Bitcoin-tip anchor.",
                examples: [(tool.outputSchema.examples[0] as { receipt: unknown }).receipt],
                oneOf: [(tool.outputSchema.properties as Record<string, unknown>).receipt, datasetReceiptDefinition.outputSchema],
              },
              provenanceVerified: field("boolean", "Whether this signed receipt binds the current verified dataset chain, not whether Bitcoin has attested its OTS proof.", [true]),
              provenanceMerkleRoot: field("string", "Dataset chain root signed in the receipt, when the referenced dataset still matches.", ["ab".repeat(32)], { pattern: "^[0-9a-f]{64}$" }),
              otsProof: field("string", "Base64 serialized .ots proof of the dataset root bytes, when a calendar receipt is available.", ["AQID"], { format: "byte" }),
              otsStatus: field("string", "Calendar-only or independently Bitcoin-verified status of the OTS receipt.", ["pending_calendar"], { enum: ["pending_calendar", "bitcoin_block_attested"] }),
            },
            required: ["receipt", "provenanceVerified"],
          },
        }
      : tool;
    return tool.name.startsWith("stratigraphy.") || tool.name.startsWith("proof.") ||
      tool.name === "mesh.broadcast"
      ? {
          ...merged,
          description: exactDescriptionToolNames.has(tool.name)
             ? merged.description
             : `${merged.description} ${immutabilityNote}`,
        }
      : merged;
  })];

const paidTools = {
  "proof.list": { amountSats: 10, schema: listProofAttestationsInputSchema },
  "stratigraphy.get": { amountSats: 250, schema: stratigraphyInputSchema },
  "stratigraphy.get_digest": { amountSats: 250, schema: stratigraphyDigestInputSchema },
  "stratigraphy.get_diff": { amountSats: 250, schema: stratigraphyDiffInputSchema },
  "stratigraphy.get_range": { amountSats: 250, schema: stratigraphyRangeInputSchema },
  // Keep the original scope and invoice description for already-issued L402 credentials.
  "stratigraphy.digest": { amountSats: 250, schema: stratigraphyDigestInputSchema },
  "stratigraphy.diff": { amountSats: 250, schema: stratigraphyDiffInputSchema },
  "stratigraphy.range": { amountSats: 250, schema: stratigraphyRangeInputSchema },
  "proof.get_by_hash": { amountSats: 250, schema: proofByHashInputSchema },
  "proof.verify": { amountSats: 250, schema: verifyProofInputSchema },
  "proof.ground": { amountSats: 250, schema: proofGroundInputSchema },
  "proof.submit": { amountSats: 250, schema: submitProofInputSchema },
  "mesh.broadcast": { amountSats: 250, schema: meshBroadcastInputSchema },
} as const;
const mcpToolPrices = Object.fromEntries(mcpToolDefinitions.map((tool) => [
  tool.name,
  Object.hasOwn(paidTools, tool.name)
    ? paidTools[tool.name as keyof typeof paidTools].amountSats
    : 0,
])) as Record<string, number>;

const legacyToolNames = {
  "payment.info": "payment.get_info",
  "stratigraphy.digest": "stratigraphy.get_digest",
  "stratigraphy.diff": "stratigraphy.get_diff",
  "stratigraphy.range": "stratigraphy.get_range",
  "mesh.status": "mesh.get_status",
} as const;

function canonicalToolName(name: string): string {
  return legacyToolNames[name as keyof typeof legacyToolNames] ?? name;
}

function toolNamesForAuthorization(name: string): string[] {
  const canonicalName = canonicalToolName(name);
  return [
    name,
    ...(canonicalName === name ? [] : [canonicalName]),
    ...Object.entries(legacyToolNames)
      .filter(([, canonical]) => canonical === canonicalName)
      .map(([legacy]) => legacy),
  ];
}

function createBitcoinStratigraphyMcpServer(
  groundReceipt?: Awaited<ReturnType<typeof groundEpistemicContext>>,
  mesh: Pick<MeshGossipService, "status" | "createConsensus"> = createMeshGossipService(),
  datasetReceipt?: Awaited<ReturnType<typeof createEpistemicDatasetReceipt>>,
  attenuation?: {
    status: "attenuated";
    attenuatedMacaroon: string;
    appliedCaveats: string[];
    issuedAt: string;
  },
  archivedProof?: ArchivedProofLookup,
  driftVerification?: { valid: boolean; startedAt: number },
  x402Configured = false,
  paymentSettlement?: SettlementCheck,
) {
  const server = new McpServer(
    {
      name: "bitcoin-stratigraphy",
      version: "1.0.0",
    },
    {
      instructions:
        "Quantitative Bitcoin stratigraphy dataset featuring thermodynamic signals, Groth16 zk-SNARK verification, and P2P mesh consensus accessible via L402 micropayments. Proof revocation is intentionally omitted: stratigraphy records and proof attestations are append-only, while Merkle roots commit dataset provenance and mesh attestations. Inbound P2P subscriptions are not exposed; mesh state is distributed through outbound broadcasts.",
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
    },
  );

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpToolDefinitions,
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const name = canonicalToolName(request.params.name);
    if (!mcpToolDefinitions.some((tool) => tool.name === name)) {
      throw new McpError(ErrorCode.InvalidParams, "Unknown MCP tool");
    }
    if (request.params.name === "stratigraphy.get") {
      const parsed = stratigraphyInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid stratigraphy query");
      }
      try {
        const records = await queryStratigraphy(parsed.data);
        const structuredContent = { records };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent,
        };
      } catch (error) {
        if (error instanceof RangeError) {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unable to retrieve stratigraphy data",
            },
          ],
        };
      }
    }
    if (name === "stratigraphy.get_digest") {
      const parsed = stratigraphyDigestInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid digest target or format");
      }
      try {
        const result = await queryStratigraphyDigest(parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { result, proofAvailable: false },
        };
      } catch (error) {
        if (error instanceof RangeError) throw new McpError(ErrorCode.InvalidParams, error.message);
        throw error;
      }
    }
    if (name === "stratigraphy.get_diff") {
      const parsed = stratigraphyDiffInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid diff targets");
      }
      try {
        const result = await queryStratigraphyDiff(parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof RangeError) throw new McpError(ErrorCode.InvalidParams, error.message);
        throw error;
      }
    }
    if (name === "stratigraphy.get_range") {
      const parsed = stratigraphyRangeInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid range bounds, limit or format");
      }
      try {
        const structuredContent = await queryStratigraphyRange(parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        if (error instanceof RangeError) throw new McpError(ErrorCode.InvalidParams, error.message);
        throw error;
      }
    }
    if (request.params.name === "stratigraphy.list") {
      if (!stratigraphyCatalogInputSchema.safeParse(args).success) {
        throw new McpError(ErrorCode.InvalidParams, "Catalog takes no arguments");
      }
      const structuredContent = await stratigraphyCatalog();
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "proof.attenuate") {
      if (!attenuation) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid or unauthorized parent macaroon");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(attenuation) }],
        structuredContent: attenuation,
      };
    }
    if (request.params.name === "proof.verify") {
      const parsed = verifyProofInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid proof payload");
      }
      if (parsed.data.proofType === "ots") {
        const structuredContent = await verifyOtsProofRecord(parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      }
      let valid: boolean;
      const startedAt = performance.now();
      if ("circuit" in parsed.data) {
        if (!driftVerification) {
          throw new McpError(ErrorCode.InternalError, "Drift proof verification provider unavailable");
        }
        valid = driftVerification.valid;
      } else {
        const { proof, publicInputs, verificationKeyId, data } = parsed.data;
        valid = await verifyZkProofForSnapshot(
          { proof, publicInputs, verificationKeyId },
          data,
        );
      }
      const structuredContent = {
        valid,
        verifiedAt: new Date().toISOString(),
        computationTimeMs: Number((
          "circuit" in parsed.data && driftVerification
            ? performance.now() - driftVerification.startedAt
            : performance.now() - startedAt
        ).toFixed(3)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (name === "proof.get_by_hash") {
      if (!proofByHashInputSchema.safeParse(args).success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid proof or receipt hash");
      }
      if (!archivedProof) {
        throw new McpError(ErrorCode.InvalidParams, "Proof or receipt not found");
      }
      const structuredContent = {
        ...archivedProof,
        ...await provenanceForReceipt(archivedProof.proofPayload),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (name === "payment.get_info") {
      const parsed = paymentInfoInputSchema.safeParse(args);
      if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, "Invalid payment info request");
      if (parsed.data.action === "settle") {
        const structuredContent = paymentSettlement ?? { verified: false, settlementToken: null };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      }
      const toolName = parsed.data.toolName
        ? canonicalToolName(parsed.data.toolName)
        : undefined;
      if (toolName && !Object.hasOwn(mcpToolPrices, toolName)) {
        throw new McpError(ErrorCode.InvalidParams, "Unknown MCP tool");
      }
      const structuredContent = {
        standardInvoiceSats: 250,
        perToolSats: toolName ? { [toolName]: mcpToolPrices[toolName] } : mcpToolPrices,
        acceptedPaymentMethods: x402Configured
          ? ["Lightning L402", "x402 Exact (Base USDC)"]
          : ["Lightning L402"],
        invoiceExpirySeconds: 3600,
        challenge: {
          httpStatus: 402,
          header: "WWW-Authenticate",
          fields: ["macaroon", "invoice", "payment_hash", "amount_sats"],
        },
        activeAuthSchemes: x402Configured ? ["L402", "x402"] : ["L402"],
        ...(x402Configured ? {
          x402: {
            network: "eip155:8453",
            scheme: "exact",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "1000",
            payTo: "0x7a4183ce5b9989833bb33133dcbb8efd6a84e775",
          },
        } : {}),
        macaroonRequirements: {
          authorizationHeader: "L402 <macaroon>:<preimage>",
          scope: "exact MCP tool path",
          maxRequests: 1,
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "proof.list") {
      const parsed = listProofAttestationsInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid proof attestation listing parameters",
        );
      }
      const listed = listZkProofAttestations(parsed.data);
      const quorumThreshold = mesh.status().quorumThreshold;
      const structuredContent = {
        attestations: listed.attestations.map((record) => ({
          ...record,
          meshQuorum: record.attestationCount >= quorumThreshold,
        })),
        total: listed.total,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "proof.submit") {
      const parsed = submitProofInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid zk proof submission");
      }
      const { proof, ...rest } = parsed.data;
      const canonicalProof = "piA" in proof
        ? { pi_a: proof.piA, pi_b: proof.piB, pi_c: proof.piC }
        : proof;
      const structuredContent = await submitZkProof({ ...rest, proof: canonicalProof });
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "proof.ground") {
      const parsed = proofGroundInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid epistemic grounding request",
        );
      }
      if ("cid" in parsed.data) {
        if (!datasetReceipt) {
          throw new McpError(ErrorCode.InternalError, "Signed dataset receipt is unavailable");
        }
        indexEpistemicDatasetReceipt(datasetReceipt);
      } else {
        if (!groundReceipt) {
          throw new McpError(ErrorCode.InternalError, "Grounding receipt is unavailable");
        }
        indexGroundedContextReceipt(groundReceipt);
      }
      const receipt = "cid" in parsed.data ? datasetReceipt! : groundReceipt!;
      const structuredContent = { receipt, ...await provenanceForReceipt(receipt) };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (name === "mesh.get_status") {
      if (!meshStatusInputSchema.safeParse(args).success) {
        throw new McpError(ErrorCode.InvalidParams, "Mesh status takes no arguments");
      }
      const structuredContent = mesh.status();
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "mesh.broadcast") {
      const parsed = meshBroadcastInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid mesh broadcast request");
      }
      if (mesh.status().configuredPeerCount === 0) {
        throw new McpError(ErrorCode.InternalError, "No mesh peers configured");
      }
      let records;
      try {
        records = await getStratigraphyData({ date: parsed.data.payload.date });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        throw error;
      }
      if (records.length !== 1) {
        throw new McpError(ErrorCode.InvalidParams, "No telemetry record exists for that date");
      }
      const signedRecord = createNostrAttestor()(records[0]!, Math.floor(Date.now() / 1_000));
      let consensus;
      try {
        consensus = await mesh.createConsensus(signedRecord, parsed.data.agentEvent
          ? { event: parsed.data.agentEvent, date: parsed.data.payload.date }
          : undefined);
      } catch (error) {
        if (error instanceof MeshQuorumError) {
          throw new McpError(ErrorCode.InternalError, error.message);
        }
        throw error;
      }
      if (consensus.peerAttestations.length < 2) {
        throw new McpError(ErrorCode.InternalError, "No mesh peer acknowledged the snapshot");
      }
      const structuredContent = {
        signalType: parsed.data.signalType,
        date: parsed.data.payload.date,
        snapshotDigest: consensus.snapshotDigest,
        peerAttestations: consensus.peerAttestations.length - 1,
        quorumThreshold: consensus.threshold,
        merkleRoot: consensus.merkleRoot,
        networkId: consensus.networkId,
        ...(parsed.data.agentEvent ? { agentPubkey: parsed.data.agentEvent.pubkey } : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${request.params.name}`,
    );
  });

  return server;
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  mesh: Pick<MeshGossipService, "status" | "createConsensus">,
): Promise<void> {
  const server = createBitcoinStratigraphyMcpServer(
    res.locals.epistemicAnchorReceipt as Awaited<ReturnType<typeof groundEpistemicContext>> | undefined,
    mesh,
    res.locals.epistemicDatasetReceipt as Awaited<ReturnType<typeof createEpistemicDatasetReceipt>> | undefined,
    res.locals.attenuation as Parameters<typeof createBitcoinStratigraphyMcpServer>[3],
    res.locals.archivedProof as ArchivedProofLookup | undefined,
    res.locals.driftVerification as { valid: boolean; startedAt: number } | undefined,
    Boolean(res.locals.x402Configured),
    res.locals.paymentSettlement as SettlementCheck | undefined,
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    // This transport is configured to return JSON for POSTs, but the SDK still
    // requires clients to advertise SSE. Allow JSON-only clients without
    // changing the response format or the behavior of GET event streams.
    const accept = req.headers.accept;
    if (req.method === "POST" &&
        accept?.toLowerCase().includes("application/json") &&
        !accept.toLowerCase().includes("text/event-stream")) {
      req.headers.accept = `${accept}, text/event-stream`;
    }
    await transport.handleRequest(req, res, req.body);
    if (!res.headersSent && !res.writableEnded) {
      res.status(502).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "MCP transport did not respond" },
        id: null,
      });
    }
  } catch (error) {
    req.log.error({ err: error }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    if (!res.headersSent || req.method !== "GET") {
      await transport.close();
      await server.close();
    } else {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  }
}

export function registerMcpRequestGuard(app: Express): void {
  app.use("/mcp", (req, res, next) => {
    // Never log Authorization, cookies, or session identifiers.
    console.log("[MCP Request]", req.method, {
      accept: req.headers.accept,
      "content-type": req.headers["content-type"],
      origin: req.headers.origin,
    }, req.url);
    next();
  });
}

export function registerMcpRoute(
  app: Express,
  options: {
    settlementRouter?: SettlementRouter;
    x402ResourceServer?: X402ResourceServerLike | null;
    sessionSecret?: string;
    usageStore?: MacaroonUsageStore;
    ledger?: RevenueLedger;
    readBitcoinTip?: () => Promise<BitcoinTip>;
    meshService?: Pick<MeshGossipService, "status" | "createConsensus">;
    revocationStore?: MacaroonRevocationStore;
  } = {},
): void {
  const rateLimit = createHttpRateLimitMiddleware(
    createSlidingWindowRateLimiter({ limit: 60, windowMs: 60_000 }),
  );
  const settlementRouter = options.settlementRouter ?? createDefaultMultiSettlementRouter();
  let x402SetupError: unknown;
  let x402Ready = Boolean(options.x402ResourceServer);
  const x402ResourceServer = Promise.resolve(
    options.x402ResourceServer === null
      ? undefined
      : options.x402ResourceServer ?? createCdpX402ResourceServer(),
  ).then((server) => {
    x402Ready = Boolean(server);
    return server;
  }).catch((error: unknown) => {
    x402SetupError = error;
    x402Ready = false;
    return undefined;
  });
  const mesh = options.meshService ?? createMeshGossipService();
  const revocationStore = options.revocationStore ?? createPostgresMacaroonRevocationStore();
  const gates = Object.fromEntries(
    Object.entries(paidTools).map(([name, { amountSats }]) => [
      name,
      (() => {
        const l402 = createL402Middleware({
        amountSats,
        description: `Bitcoin Stratigraphy MCP ${name} execution`,
        settlementRouter,
        sessionSecret: options.sessionSecret,
        usageStore: options.usageStore,
        revocationStore,
        ledger: options.ledger,
        scopePath: `/mcp/tools/${name}`,
        requestKind: name.startsWith("proof.") ? "zk-proof" : "stratigraphy",
        });
        return async (req: Request, res: Response, next: NextFunction) => {
          if (req.header("PAYMENT-SIGNATURE")) {
            const server = await x402ResourceServer;
            if (!server) {
              if (x402SetupError) {
                req.log?.error({ err: x402SetupError }, "CDP x402 setup failed");
              }
              res.status(503).json({ error: "x402 settlement is not configured" });
              return;
            }
            createX402PaymentMiddleware({ resourceServer: server })(
              req, res, () => next(),
            );
            return;
          }
           // An unauthenticated challenge is only a quote. It does not grant
           // tool access; a signed x402 request still requires live settlement.
           const server = x402Ready ? await x402ResourceServer : undefined;
          createX402PaymentMiddleware({ resourceServer: server })(
            req, res, () =>
               l402(req, res, next),
          );
        };
      })(),
    ]),
  ) as Record<string, (req: Request, res: Response, next: NextFunction) => void | Promise<void>>;
  app.all("/mcp", rateLimit, (req, res, next) => {
    res.locals.x402Configured = x402Ready;
    if (req.method === "GET" && !req.get("Accept")?.toLowerCase().includes("text/event-stream")) {
      res.status(200).json({ status: "ok", service: "MCP Server" });
      return;
    }
    next();
  }, async (req, res, next) => {
    const body = req.body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (body?.method !== "tools/call" ||
      (body.params?.name !== "payment.get_info" && body.params?.name !== "payment.info")) {
      next();
      return;
    }
    const parsed = paymentInfoInputSchema.safeParse(body.params.arguments ?? {});
    if (!parsed.success || parsed.data.action !== "settle") {
      next();
      return;
    }
    const input = parsed.data;
    const invalid: SettlementCheck = { verified: false, settlementToken: null };
    res.locals.paymentSettlement = invalid;
    const paymentHash = input.paymentHash.replace(/^0x/i, "").toLowerCase();
    if (input.preimage !== undefined) {
      const authorization = parseL402Header(req.header("Authorization"));
      const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
      const pass = authorization && secret
        ? verifySubscriptionMacaroon(authorization.macaroon, secret, Math.floor(Date.now() / 1_000))
        : null;
      const originalPath = pass?.allowedPaths[0];
      const originalTool = originalPath?.startsWith("/mcp/tools/")
        ? originalPath.slice("/mcp/tools/".length)
        : "";
      if (!authorization || !pass || authorization.preimage !== input.preimage.toLowerCase() ||
        pass.paymentHash !== paymentHash ||
        createHash("sha256").update(Buffer.from(input.preimage, "hex")).digest("hex") !== paymentHash ||
        pass.paymentAsset !== "btc-lightning" || !pass.paymentProvider ||
        pass.allowedPaths.length !== 1 || !Object.hasOwn(paidTools, originalTool) ||
        pass.amountMsats !== paidTools[originalTool as keyof typeof paidTools].amountSats * 1_000) {
        next();
        return;
      }
      try {
        if (await revocationStore.isRevoked(pass.tokenId)) {
          next();
          return;
        }
        const verified = await settlementRouter.verifyPayment({
          paymentHash,
          preimage: input.preimage.toLowerCase(),
          expectedAmountMsats: pass.amountMsats,
          expectedDescription: `Bitcoin Stratigraphy MCP ${originalTool} execution`,
          expectedProvider: pass.paymentProvider,
          asset: "btc-lightning",
        });
        if (verified === "unavailable") {
          res.status(503).json({ error: "Payment verifier unavailable" });
          return;
        }
        if (verified !== "invalid" && verified.provider === pass.paymentProvider &&
          (verified.asset === undefined || verified.asset === "btc-lightning")) {
          res.locals.paymentSettlement = {
            verified: true,
            settlementToken: {
              scheme: "L402",
              paymentHash,
              scope: originalPath!,
              settledAt: new Date(verified.settledAt < 10_000_000_000
                ? verified.settledAt * 1_000 : verified.settledAt).toISOString(),
            },
          } satisfies SettlementCheck;
        }
      } catch (error) {
        req.log?.warn({ err: error }, "MCP settlement verification unavailable");
        res.status(503).json({ error: "Payment verifier unavailable" });
        return;
      }
      next();
      return;
    }
    if (!req.header("PAYMENT-SIGNATURE") ||
      input.txHash!.slice(2).toLowerCase() !== paymentHash) {
      next();
      return;
    }
    const server = await x402ResourceServer;
    if (!server) {
      res.status(503).json({ error: "x402 settlement is not configured" });
      return;
    }
    await createX402PaymentMiddleware({ resourceServer: server })(req, res, () => {
      const settled = res.locals.x402 as {
        transaction?: string; network?: string;
      } | undefined;
      if (settled?.network === "eip155:8453" &&
        settled.transaction?.toLowerCase() === input.txHash!.toLowerCase()) {
        res.locals.paymentSettlement = {
          verified: true,
          settlementToken: {
            scheme: "x402",
            paymentHash: input.txHash!.toLowerCase(),
            scope: "/mcp",
            settledAt: new Date().toISOString(),
          },
        } satisfies SettlementCheck;
      }
      next();
    });
  }, async (req, res, next) => {
    if (Array.isArray(req.body)) {
      if (req.body.some((item: unknown) =>
        item !== null && typeof item === "object" &&
        (item as { method?: unknown }).method === "tools/call" &&
        (Object.hasOwn(paidTools, String((item as { params?: { name?: unknown } }).params?.name ?? "")) ||
          (item as { params?: { name?: unknown } }).params?.name === "proof.attenuate")
      )) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Batch paid tool calls are not supported" },
          id: null,
        });
        return;
      }
      next();
      return;
    }
    const body = req.body as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    const name = body?.method === "tools/call" ? body.params?.name : undefined;
    if (name === "proof.attenuate") {
      const parsed = attenuateInputSchema.safeParse(body?.params?.arguments ?? {});
      if (!parsed.success) {
        res.status(400).json({
          jsonrpc: "2.0", id: body?.id ?? null,
          error: { code: -32602, message: "Invalid attenuation input" },
        });
        return;
      }
      const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
      if (!secret) {
        res.status(503).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32603, message: "Macaroon verification unavailable" } });
        return;
      }
      const now = Date.now();
      const parent = verifySubscriptionMacaroon(parsed.data.macaroon, secret, Math.floor(now / 1_000));
      if (!parent || !getMacaroonSignatureId(parsed.data.macaroon)) {
        res.status(401).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "Invalid or expired parent macaroon" } });
        return;
      }
      try {
        if (await revocationStore.isRevoked(parent.tokenId)) {
          res.status(401).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "Parent macaroon is revoked" } });
          return;
        }
      } catch (error) {
        req.log?.error({ err: error }, "MCP macaroon revocation lookup failed");
        res.status(503).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32603, message: "Revocation lookup unavailable" } });
        return;
      }
      let caveats: string[];
      try {
        caveats = normalizedAttenuationCaveats(parsed.data, now);
      } catch (error) {
        res.status(400).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: error instanceof Error ? error.message : "Invalid attenuation caveats" } });
        return;
      }
      const child = attenuateSubscriptionMacaroon(parsed.data.macaroon, caveats);
      if (!child || !verifySubscriptionMacaroon(child, secret, Math.floor(now / 1_000))) {
        res.status(400).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32602, message: "Invalid attenuation caveats or expired child" } });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.locals.attenuation = {
        status: "attenuated",
        attenuatedMacaroon: child,
        appliedCaveats: caveats,
        issuedAt: new Date(now).toISOString(),
      };
      next();
      return;
    }
    if (typeof name !== "string" || !Object.hasOwn(paidTools, name)) {
      next();
      return;
    }
    const canonicalName = canonicalToolName(name);
    const tool = paidTools[name as keyof typeof paidTools];
    if (!tool.schema.safeParse(body?.params?.arguments ?? {}).success) {
      next();
      return;
    }
    if (name === "proof.get_by_hash") {
      const lookup = proofByHashInputSchema.parse(body?.params?.arguments ?? {});
      const found = findArchivedProof(lookup.hash ?? lookup.jobId!, mesh.status().quorumThreshold);
      if (!found) {
        res.status(404).json({
          jsonrpc: "2.0",
          id: typeof body?.id === "string" || typeof body?.id === "number" ? body.id : null,
          error: { code: -32004, message: "Proof or receipt not found" },
        });
        return;
      }
      res.locals.archivedProof = found;
    }
    const authorization = parseL402Header(req.header("Authorization"));
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    const pass = authorization && secret
      ? verifySubscriptionMacaroon(authorization.macaroon, secret, Math.floor(Date.now() / 1_000))
      : null;
    if (pass && (
      pass.allowedToolSets.some((set) =>
        !toolNamesForAuthorization(name).some((allowedName) => set.includes(allowedName))
      ) ||
      (pass.maxTarget !== undefined &&
        !(await withinMcpTargetBound(canonicalName, body?.params?.arguments ?? {}, pass.maxTarget)))
    )) {
      res.status(403).json({
        jsonrpc: "2.0", id: body?.id ?? null,
        error: { code: -32602, message: "Macaroon tool or target caveat forbids this request" },
      });
      return;
    }
    if (canonicalName === "stratigraphy.get_digest" ||
      canonicalName === "stratigraphy.get_diff" ||
      canonicalName === "stratigraphy.get_range") {
      try {
        if (canonicalName === "stratigraphy.get_digest") {
          await queryStratigraphyDigest(stratigraphyDigestInputSchema.parse(body?.params?.arguments ?? {}));
        } else if (canonicalName === "stratigraphy.get_range") {
          await queryStratigraphyRange(stratigraphyRangeInputSchema.parse(body?.params?.arguments ?? {}));
        } else {
          await queryStratigraphyDiff(stratigraphyDiffInputSchema.parse(body?.params?.arguments ?? {}));
        }
      } catch (error) {
        if (!(error instanceof RangeError)) return next(error);
        res.status(400).json({
          jsonrpc: "2.0",
          id: typeof body?.id === "string" || typeof body?.id === "number" ? body.id : null,
          error: { code: -32602, message: error.message },
        });
        return;
      }
    }
    if (name === "mesh.broadcast" && mesh.status().configuredPeerCount === 0) {
      res.status(503).json({
        jsonrpc: "2.0",
        id: typeof body?.id === "string" || typeof body?.id === "number" ? body.id : null,
        error: { code: -32603, message: "No mesh peers configured" },
      });
      return;
    }
    if (name === "proof.ground") {
      const parsed = proofGroundInputSchema.safeParse(body!.params?.arguments ?? {});
      if (!parsed.success) {
        next();
        return;
      }
      const input = parsed.data;
      if ("cid" in input) {
        if (Buffer.byteLength(JSON.stringify(input)) > 16_384) {
          res.status(400).json({
            jsonrpc: "2.0", id: body?.id ?? null,
            error: { code: -32602, message: "Dataset receipt metadata exceeds 16 KiB" },
          });
          return;
        }
      } else {
        if (input.metadata && Buffer.byteLength(JSON.stringify(input.metadata)) > 16_384) {
          res.status(400).json({
            jsonrpc: "2.0", id: body?.id ?? null,
            error: { code: -32602, message: "Grounding metadata exceeds 16 KiB" },
          });
          return;
        }
      }
    }
    gates[name](req, res, next);
  }, async (req, res, next) => {
    const body = req.body as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (body?.method !== "tools/call" || body.params?.name !== "proof.verify") {
      next();
      return;
    }
    const parsed = driftProofInputSchema.safeParse(body.params?.arguments ?? {});
    if (!parsed.success) {
      next();
      return;
    }
    const { circuit: _circuit, ...verifyInput } = parsed.data;
    const startedAt = performance.now();
    try {
      const valid = await verifyDriftProof(verifyInput);
      res.locals.driftVerification = { valid, startedAt };
    } catch (error) {
      req.log?.warn({ err: error }, "MCP drift proof verifier unavailable");
      res.status(503).json({
        jsonrpc: "2.0",
        id: typeof body.id === "string" || typeof body.id === "number" ? body.id : null,
        error: { code: -32603, message: "Drift proof verification provider unavailable" },
      });
      return;
    }
    next();
  }, async (req, res, next) => {
    const body = req.body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (body?.method !== "tools/call" || body.params?.name !== "proof.ground") {
      next();
      return;
    }
    const parsed = proofGroundInputSchema.safeParse(body.params?.arguments ?? {});
    if (!parsed.success) {
      next();
      return;
    }
    const input = parsed.data;
    try {
      const current = buildProvenanceChain(await readDataset());
      const datasetProvenance: BoundProvenance = {
        headHash: current.headHash, merkleRoot: current.merkleRoot,
        totalDepth: current.totalDepth,
      };
      if ("cid" in input) {
        res.locals.epistemicDatasetReceipt = await createEpistemicDatasetReceipt({
          ...input, context: { ...input.context, datasetProvenance },
        }, {
          readBitcoinTip: options.readBitcoinTip,
        });
      } else {
        res.locals.epistemicAnchorReceipt = await groundEpistemicContext({
          ...input, metadata: { ...input.metadata, datasetProvenance },
        }, {
          readBitcoinTip: options.readBitcoinTip,
        });
      }
    } catch (error) {
      req.log?.warn({ err: error }, "MCP epistemic grounding post-payment failed");
      res.status(503).json({ error: "Bitcoin chain state or receipt signing is unavailable" });
      return;
    }
    next();
  }, (req, res) => handleMcpRequest(req, res, mesh), (_req, res) => {
    if (!res.headersSent) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Invalid Request" },
        id: null,
      });
    }
  });
  app.all(/^\/mcp\/.+/, (_req, res) => {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
      id: null,
    });
  });
  // JSON body-parser errors happen before the transport; do not send Express's HTML error page.
  app.use("/mcp", (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const incomingStatus = (error as { status?: unknown }).status;
    const status = typeof incomingStatus === "number" &&
        incomingStatus >= 400 && incomingStatus < 500
      ? incomingStatus
      : 500;
    req.log?.warn({ status }, "MCP request rejected");
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: status === 400 ? -32700 : -32603,
        message: status === 400 ? "Invalid JSON request" : "Internal server error",
      },
      id: null,
    });
  });
}