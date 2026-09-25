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
import { createL402Middleware } from "../middleware/l402";
import { createDefaultMultiSettlementRouter } from "../services/multiSettlement";
import type { SettlementRouter } from "../services/settlement";
import type { MacaroonUsageStore } from "../lib/macaroon-usage-store";
import type { RevenueLedger } from "../services/ledger";
import {
  groundEpistemicContext,
  type BitcoinTip,
} from "../services/epistemicGrounding";
import {
  createMeshGossipService,
  MeshQuorumError,
  type MeshGossipService,
} from "../services/meshGossipService";
import { createNostrAttestor } from "../services/nostrAttestation";
import {
  getZkProofStatus,
  listZkProofAttestations,
  submitZkProof,
  verifyZkProofForSnapshot,
} from "../services/zkProofService";
import { getStratigraphyData } from "./stratigraphy";
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

const stratigraphyCatalogInputSchema = z.object({}).strict().describe(
  "No input parameters required.",
);

const verifyProofInputSchema = z.object({
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

const proofStatusInputSchema = z.object({
  proofHash: z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$|^Qm[1-9A-HJ-NP-Za-km-z]{44}$|^b[a-z2-7]{20,}$/).optional().describe(
    "Primary lookup key for a proof lifecycle record (hex digest or CID); mutually exclusive with snapshotDigest.",
  ),
  snapshotDigest: z.string().regex(/^(?:\d+|[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/).optional().describe(
    "Primary lookup key for a snapshot lifecycle record (decimal digest, hex digest, or CID); mutually exclusive with proofHash.",
  ),
}).strict().refine(
  (input) =>
    (input.proofHash === undefined) !== (input.snapshotDigest === undefined),
  "Provide exactly one of proofHash or snapshotDigest",
).describe("Input arguments for querying single proof attestation lifecycle status.");

const proofLifecycleStates = [
  "verified",
  "cached",
  "pending",
  "invalid",
] as const;

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

const LATEST_DATASET_DATE = "2026-09-09";
const LATEST_DATASET_BLOCK = 920_000;
const BLOCKS_PER_RECORDED_EPOCH = 144;
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

function snapshotDate(index: number, total: number): string {
  return new Date(
    Date.parse(`${LATEST_DATASET_DATE}T00:00:00.000Z`) -
      (total - index - 1) * DAY_MS,
  ).toISOString().slice(0, 10);
}

function snapshotBlock(index: number, total: number): number {
  return LATEST_DATASET_BLOCK -
    (total - index - 1) * BLOCKS_PER_RECORDED_EPOCH;
}

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

const baseMcpToolDefinitions = [
  {
    name: "stratigraphy.get",
    title: "Get Bitcoin Stratigraphy",
    description:
      "Fetch Bitcoin Stratigraphy telemetry by days (1-365), date, indexed blockHeight, or inclusive open-ended date/block ranges, with optional metrics projection and limit (1-100); use this tool to retrieve historical thermodynamic valuations, not to discover dataset boundaries (use stratigraphy.list); single selectors cannot be combined with ranges. Returns a JSON object containing records, an array of matching daily snapshots with quantitative_alpha metrics, or an empty array when none match. This read-only call costs 250 sats through L402, shares a 60-requests-per-minute IP limit, and rejects invalid selectors with JSON-RPC -32602.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Stratigraphy telemetry query parameters.",
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
          "Count of recent days of telemetry to fetch (integer, 1-365).",
          [7],
          { minimum: 1, maximum: 365 },
        ),
        date: field(
          "string",
          "Calendar date selecting one telemetry day, formatted as YYYY-MM-DD in UTC.",
          ["2026-09-19"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        blockHeight: field(
          "integer",
          "Indexed Bitcoin block height selecting one telemetry record (non-negative integer).",
          [850000],
          { minimum: 0 },
        ),
        metrics: field(
          "array",
          "Array of specific telemetry metric key strings to project into returned records.",
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
          "Maximum number of records to return (integer, 1-100).",
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
    name: "stratigraphy.list",
    title: "List Stratigraphy Catalog",
    description:
      "Discover Bitcoin Stratigraphy catalog bounds, indexed block heights, date ranges, and metric keys before calling stratigraphy.get; pass an empty object and do not use this tool to fetch telemetry records. Returns a JSON object with totalSnapshots, oldestBlock, newestBlock, availableMetrics, and inclusive dateBounds containing startDate and endDate. This read-only catalog call costs 10 sats through L402, shares a 60-requests-per-minute IP limit, and rejects unexpected input with JSON-RPC -32602.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "No input parameters required.",
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
    name: "proof.verify",
    title: "Verify Stratigraphy ZK Proof",
    description:
      "Verify a base64url Groth16/Poseidon BN254 proof against required publicInputs, verificationKeyId, and telemetry data; use this tool for transient proof testing, not for proof submission or Nostr publication (use proof.submit). Returns a JSON object with boolean valid, ISO verifiedAt, and computationTimeMs; a cryptographic or snapshot mismatch returns valid false rather than publishing a proof. This 250-sat L402 call updates only bounded process-memory verification indexes, shares a 60-requests-per-minute IP limit, and rejects malformed inputs with JSON-RPC -32602.",
    annotations: proofVerificationToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input arguments containing an encoded Groth16 proof, typed public inputs, a verification-key identifier, and telemetry data.",
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
    name: "proof.status",
    title: "Get Proof Status",
    description:
      "Look up one process-memory proof lifecycle and attestation state using exactly one proofHash or snapshotDigest; use this tool for a known identifier, not to list multiple proofs (use proof.list) or execute verification (use proof.verify). Returns a JSON object with status (verified, cached, pending, or invalid), ISO verifiedAt, attestationCount, and boolean meshQuorum; unknown identifiers return pending. This read-only lookup costs 10 sats through L402, shares a 60-requests-per-minute IP limit, and rejects missing or conflicting selectors with JSON-RPC -32602.",
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
      },
      required: [],
      oneOf: [
        { required: ["proofHash"] },
        { required: ["snapshotDigest"] },
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
    name: "proof.list",
    title: "List Proof Attestations",
    description:
      "List recent proof attestations in bounded process memory with optional status, limit (1-100, default 20), and offset (0-1000, default 0); use this tool to discover hashes or review historical states, not to submit proofs (use proof.submit) or ground context (use proof.ground). Returns a JSON object containing newest-first attestations with proofHash, snapshotDigest, status, submittedAt, attestationCount, and meshQuorum, plus total before pagination. This read-only listing costs 10 sats through L402, shares a 60-requests-per-minute IP limit, and rejects invalid filters with JSON-RPC -32602.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input options for listing and discovering historical zk-SNARK proof attestations.",
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
      "Submit Groth16/BN254 proof coordinates and five ordered publicSignals for verification and possible Nostr NIP-78 publication; use this tool to record an attestation, not for transient proof testing (use proof.verify). Returns a JSON object with proofHash, verified or invalid status, ISO submittedAt, and attestationStatus indicating whether Nostr NIP-78 publication succeeded or was skipped; the bounded process-memory lifecycle index is not durable. This state-changing 250-sat L402 call shares a 60-requests-per-minute IP limit, accepts legacy pi_a/pi_b/pi_c input for existing clients, and rejects malformed fields with JSON-RPC -32602.",
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
      "Ground agent context in the current Bitcoin block tip using contextHash, agentId, and optional metadata; use this tool when execution state needs a signed cryptographic receipt, not for general telemetry (use stratigraphy.get) or ZK proof submission (use proof.submit). Returns a JSON object containing a signed receipt with normalized contextHash, agentId, blockHeight, blockHash, timestamp, Merkle proof, and NIP-78 signature, verifiable through POST /api/v1/zk/verify. This 250-sat L402 call checks signing readiness before charging, shares a 60-requests-per-minute IP limit, and rejects malformed inputs with JSON-RPC -32602.",
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
    name: "mesh.status",
    title: "Get Mesh Status",
    description:
      "Inspect current in-process P2P mesh topology, active peer count, and consensus readiness before mesh.broadcast; pass an empty object, and do not use this tool for individual proof verification (use proof.verify) or telemetry records (use stratigraphy.get). Returns a JSON object containing nodePubkey, activePeerCount, configuredPeerCount, topologyHealth, crossValidationSuccessRate, averagePropagationLatencyMs, and quorumThreshold. This read-only tool is free, shares a 60-requests-per-minute IP limit, and rejects unexpected inputs with JSON-RPC -32602.",
    annotations: meshStatusToolAnnotations,
    inputSchema: {
      type: "object",
      description: "No input parameters required.",
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
      "Broadcast a freshly signed canonical telemetry snapshot to pinned P2P mesh peers using signalType telemetry_snapshot and payload.date; use this tool after local record generation to establish multi-node consensus, not to inspect topology (use mesh.status) or fetch records (use stratigraphy.get); arbitrary snapshots and peer targets are not accepted. Returns a JSON object with signalType, date, snapshotDigest, peerAttestations received, quorumThreshold, merkleRoot, and networkId after peer cross-validation. This active 250-sat L402 call requires configured peers and a successful quorum, shares a 60-requests-per-minute IP limit, and rejects invalid inputs with JSON-RPC -32602.",
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
              "UTC calendar date of the existing record to distribute, formatted YYYY-MM-DD.",
              ["2026-09-09"],
              { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            ),
          },
          required: ["date"],
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
      },
      required: ["signalType", "date", "snapshotDigest", "peerAttestations", "quorumThreshold", "merkleRoot", "networkId"],
    },
  },
];

const immutabilityNote =
  "Note: Stratigraphy records and zk-SNARK proofs are append-only and immutable by design; update and delete operations are intentionally non-existent.";
const mcpToolDefinitions = baseMcpToolDefinitions.map((tool) =>
  tool.name.startsWith("stratigraphy.") || tool.name.startsWith("proof.") ||
    tool.name === "mesh.broadcast"
    ? { ...tool, description: `${tool.description} ${immutabilityNote}` }
    : tool
);

function createBitcoinStratigraphyMcpServer(
  groundReceipt?: Awaited<ReturnType<typeof groundEpistemicContext>>,
  mesh: Pick<MeshGossipService, "status" | "createConsensus"> = createMeshGossipService(),
) {
  const server = new McpServer(
    {
      name: "bitcoin-stratigraphy",
      version: "1.0.0",
    },
    {
      instructions:
        "Returns Bitcoin Stratigraphy data with Nostr NIP-78 attestations and zkProof payloads. Verify emitted Groth16/Poseidon BN254 proofs with POST /api/v1/zk/verify; emitted proofs are pre-verified for sub-10ms verification. Paid access supports L402 multi-asset settlement.",
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
    if (request.params.name === "proof.verify") {
      const parsed = verifyProofInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid proof payload");
      }
      const { proof, publicInputs, verificationKeyId, data } = parsed.data;
      const startedAt = performance.now();
      const valid = await verifyZkProofForSnapshot(
        { proof, publicInputs, verificationKeyId },
        data,
      );
      const structuredContent = {
        valid,
        verifiedAt: new Date().toISOString(),
        computationTimeMs: Number((performance.now() - startedAt).toFixed(3)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "proof.status") {
      const parsed = proofStatusInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Provide exactly one proofHash or snapshotDigest",
        );
      }
      const identifier = parsed.data.proofHash ?? parsed.data.snapshotDigest!;
      const history = getZkProofStatus(identifier);
      const attestationCount = history?.attestationCount ?? 0;
      const structuredContent = {
        status: history?.status ?? "pending",
        verifiedAt: history?.verifiedAt ?? new Date().toISOString(),
        attestationCount,
        meshQuorum: attestationCount >= mesh.status().quorumThreshold,
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
      const parsed = groundContextInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid epistemic grounding request",
        );
      }
      if (!groundReceipt) {
        throw new McpError(ErrorCode.InternalError, "Grounding receipt is unavailable");
      }
      const structuredContent = { receipt: groundReceipt };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "mesh.status") {
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
        consensus = await mesh.createConsensus(signedRecord);
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
    sessionSecret?: string;
    usageStore?: MacaroonUsageStore;
    ledger?: RevenueLedger;
    readBitcoinTip?: () => Promise<BitcoinTip>;
    meshService?: Pick<MeshGossipService, "status" | "createConsensus">;
  } = {},
): void {
  const rateLimit = createHttpRateLimitMiddleware(
    createSlidingWindowRateLimiter({ limit: 60, windowMs: 60_000 }),
  );
  const settlementRouter = options.settlementRouter ?? createDefaultMultiSettlementRouter();
  const mesh = options.meshService ?? createMeshGossipService();
  const paidTools = {
    "stratigraphy.list": { amountSats: 10, schema: stratigraphyCatalogInputSchema },
    "proof.list": { amountSats: 10, schema: listProofAttestationsInputSchema },
    "proof.status": { amountSats: 10, schema: proofStatusInputSchema },
    "stratigraphy.get": { amountSats: 250, schema: stratigraphyInputSchema },
    "proof.verify": { amountSats: 250, schema: verifyProofInputSchema },
    "proof.ground": { amountSats: 250, schema: groundContextInputSchema },
    "proof.submit": { amountSats: 250, schema: submitProofInputSchema },
    "mesh.broadcast": { amountSats: 250, schema: meshBroadcastInputSchema },
  } as const;
  const gates = Object.fromEntries(
    Object.entries(paidTools).map(([name, { amountSats }]) => [
      name,
      createL402Middleware({
        amountSats,
        description: `Bitcoin Stratigraphy MCP ${name} execution`,
        settlementRouter,
        sessionSecret: options.sessionSecret,
        usageStore: options.usageStore,
        ledger: options.ledger,
        scopePath: `/mcp/tools/${name}`,
        requestKind: name.startsWith("proof.") ? "zk-proof" : "stratigraphy",
      }),
    ]),
  ) as Record<string, ReturnType<typeof createL402Middleware>>;
  app.all("/mcp", rateLimit, (req, res, next) => {
    if (req.method === "GET" && !req.get("Accept")?.toLowerCase().includes("text/event-stream")) {
      res.status(200).json({ status: "ok", service: "MCP Server" });
      return;
    }
    next();
  }, async (req, res, next) => {
    if (Array.isArray(req.body)) {
      if (req.body.some((item: unknown) =>
        item !== null && typeof item === "object" &&
        (item as { method?: unknown }).method === "tools/call" &&
        Object.hasOwn(paidTools, String((item as { params?: { name?: unknown } }).params?.name ?? ""))
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
    if (typeof name !== "string" || !Object.hasOwn(paidTools, name)) {
      next();
      return;
    }
    const tool = paidTools[name as keyof typeof paidTools];
    if (!tool.schema.safeParse(body?.params?.arguments ?? {}).success) {
      next();
      return;
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
      const input = groundContextInputSchema.parse(body!.params?.arguments ?? {});
      if (input.metadata && Buffer.byteLength(JSON.stringify(input.metadata)) > 16_384) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32602, message: "Grounding metadata exceeds 16 KiB" },
          id: typeof (body as { id?: unknown }).id === "number" ? (body as { id: number }).id : null,
        });
        return;
      }
      try {
        res.locals.epistemicAnchorReceipt = await groundEpistemicContext(input, {
          readBitcoinTip: options.readBitcoinTip,
        });
      } catch (error) {
        req.log?.warn({ err: error }, "MCP epistemic grounding preflight failed");
        res.status(503).json({ error: "Bitcoin chain state or receipt signing is unavailable" });
        return;
      }
    }
    gates[name](req, res, next);
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