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
import { createMeshGossipService } from "../services/meshGossipService";
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
    "Inclusive UTC lower date bound formatted as YYYY-MM-DD.",
  ),
  endDate: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Inclusive UTC upper date bound formatted as YYYY-MM-DD.",
  ),
  startBlock: z.number().int().nonnegative().optional().describe(
    "Inclusive lower bound of the daily block-height index.",
  ),
  endBlock: z.number().int().nonnegative().optional().describe(
    "Inclusive upper bound of the daily block-height index.",
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
  publicInputs: publicInputsSchema,
  verificationKeyId: z.string().min(1).describe(
    "SHA-256 verification-key identifier using the sha256: prefix.",
  ),
  data: snapshotSchema,
}).strict().describe(
  "Input arguments containing an encoded Groth16 proof, typed public inputs, a verification-key identifier, and telemetry data.",
);

const proofStatusInputSchema = z.object({
  proofHash: z.string().regex(/^(?:0x)?[0-9a-fA-F]{64}$|^Qm[1-9A-HJ-NP-Za-km-z]{44}$|^b[a-z2-7]{20,}$/).optional().describe(
    "Canonical IPFS CID or hex digest identifier string.",
  ),
  snapshotDigest: z.string().regex(/^(?:\d+|[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/).optional().describe(
    "Decimal field digest, 64-digit hexadecimal digest, or IPFS CID identifier string.",
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
    "Maximum number of records to return.",
  ),
  offset: z.number().int().min(0).max(1_000).default(0).describe(
    "Zero-based pagination skip offset.",
  ),
  status: z.enum(proofLifecycleStates).optional().describe(
    "Filter records by attestation lifecycle state.",
  ),
}).strict().describe(
  "Input options for listing and discovering historical zk-SNARK proof attestations.",
);

const submitProofInputSchema = z.object({
  proof: z.object({
    pi_a: z.array(
      z.string().regex(/^\d+$/).describe(
        "Decimal-encoded BN254 scalar-field coordinate in proof point A.",
      ),
    ).length(3).describe(
      "Groth16 BN254 proof A projective coordinates.",
    ),
    pi_b: z.array(
      z.array(
        z.string().regex(/^\d+$/).describe(
          "Decimal-encoded BN254 extension-field coordinate in proof point B.",
        ),
      ).length(2).describe(
        "BN254 extension-field coordinate pair in proof point B.",
      ),
    ).length(3).describe(
      "Groth16 BN254 proof B projective coordinates.",
    ),
    pi_c: z.array(
      z.string().regex(/^\d+$/).describe(
        "Decimal-encoded BN254 scalar-field coordinate in proof point C.",
      ),
    ).length(3).describe(
      "Groth16 BN254 proof C projective coordinates.",
    ),
  }).strict().describe(
    "Groth16/Poseidon zk-SNARK proof coordinates over the BN254 curve.",
  ),
  publicSignals: z.array(
    z.string().regex(/^\d+$/).describe(
      "Decimal-encoded BN254 scalar-field element.",
    ),
  ).length(5).describe(
    "Public signals ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest.",
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

const groundContextInputSchema = z.object({
  contextHash: z.string().regex(/^[0-9a-fA-F]{64}$/).describe(
    "64-character case-insensitive hexadecimal SHA-256 digest string.",
  ),
  agentId: z.string().trim().min(1).max(256).describe(
    "Trimmed caller-controlled identifier string from 1 to 256 characters.",
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
) => ({
  type,
  description,
  example: examples[0],
  examples,
  default: examples[0],
  ...extra,
});

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
    "Object containing exactly five typed public statement inputs committed by the Groth16/Poseidon proof.",
  examples: [{
    blockHeight: 920000,
    snapshotDigest: "1534979302823651498736582947365829473658294736582947365829473658294",
    thermodynamicHash: "782365829473658294736582947365829473658294736582947365829473658294",
    timestamp: 1789776000000,
    valuationSat: 12583,
  }],
  default: {
    blockHeight: 920000,
    snapshotDigest: "1534979302823651498736582947365829473658294736582947365829473658294",
    thermodynamicHash: "782365829473658294736582947365829473658294736582947365829473658294",
    timestamp: 1789776000000,
    valuationSat: 12583,
  },
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
      "PURPOSE: Retrieves Bitcoin Stratigraphy telemetry records by recent-day count, date, block height, or inclusive date and block ranges.\nUSAGE: Use to fetch telemetry records and selected thermodynamic metrics. Do NOT use for catalog coverage discovery; use stratigraphy.list instead.\nPARAMETERS: days is an integer from 1 to 365; date is YYYY-MM-DD; blockHeight is a non-negative integer; metrics is a unique non-empty array containing target_multiplier, difficulty_epoch_progress, or thermodynamic_signal; startDate and endDate are inclusive YYYY-MM-DD bounds; startBlock and endBlock are inclusive non-negative integer bounds; limit is an integer from 1 to 100 with default 10.\nBEHAVIOR: Reads the local telemetry dataset without database writes. Only one of days, date, or blockHeight may be supplied, and none may be combined with range selectors; lower bounds cannot exceed upper bounds. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing records, an array of matching telemetry entries, limited and optionally projected by metrics; an unmatched query returns an empty array.\nERRORS: -32602 (Invalid Parameters) for invalid fields, selector combinations, bounds, or ranges; HTTP 429 (Rate Limit) when the shared limit is exceeded; dataset retrieval failures return an MCP tool error. No 402 payment required.",
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
          { minimum: 1, maximum: 365, default: 30 },
        ),
        date: field(
          "string",
          "Calendar date selecting one telemetry day, formatted as YYYY-MM-DD in UTC.",
          ["2026-09-19"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
            default: "2026-09-09",
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
          "Inclusive lower date bound formatted as YYYY-MM-DD in UTC.",
          ["2026-09-01"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        endDate: field(
          "string",
          "Inclusive upper date bound formatted as YYYY-MM-DD in UTC (must be >= startDate).",
          ["2026-09-18"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        startBlock: field(
          "integer",
          "Inclusive lower block height bound (non-negative integer).",
          [910000],
          { minimum: 0 },
        ),
        endBlock: field(
          "integer",
          "Inclusive upper block height bound (non-negative integer, must be >= startBlock).",
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
      "PURPOSE: Lists complete Bitcoin Stratigraphy catalog coverage and available metric paths.\nUSAGE: Use to discover snapshot, date, block, and metric coverage. Do NOT use for fetching telemetry records; use stratigraphy.get instead.\nPARAMETERS: No input properties are accepted.\nBEHAVIOR: Summarizes the local catalog without modifying records. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing totalSnapshots, oldestBlock, newestBlock, availableMetrics, and dateBounds with startDate and endDate.\nERRORS: -32602 (Invalid Parameters) when any input property is supplied; HTTP 429 (Rate Limit) when the shared limit is exceeded; catalog retrieval failures return an MCP error. No 402 payment required.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "No input parameters required.",
      examples: [{}],
      additionalProperties: false,
      properties: {},
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
      "PURPOSE: Verifies a base64url-encoded Groth16/Poseidon BN254 proof against typed public claims and a telemetry snapshot.\nUSAGE: Use to validate a proof against snapshot data. Do NOT use to submit proof coordinates for optional Nostr publication; use proof.submit instead.\nPARAMETERS: proof is a non-empty base64url proof string; publicInputs is an object with non-negative integer blockHeight, non-empty string snapshotDigest, non-empty string thermodynamicHash, non-negative integer timestamp, and non-negative integer valuationSat; verificationKeyId is a non-empty string; data is a telemetry object or an array of telemetry objects.\nBEHAVIOR: Checks the snapshot digest, semantic claims, verification-key identifier, and Groth16 proof in memory, and updates bounded process-memory verification and lifecycle indexes without durable database storage. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing valid, verifiedAt, and computationTimeMs; proof, snapshot, semantic, or key mismatches produce valid false.\nERRORS: -32602 (Invalid Parameters) for malformed or missing input properties; HTTP 429 (Rate Limit) when the shared limit is exceeded. No 402 payment required.",
    annotations: readOnlyToolAnnotations,
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
            "Object containing five typed public statement inputs committed by the proof.",
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
        error: "Verification key identifier does not match the proof.",
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
          "ISO 8601 UTC date string format.",
          ["2026-09-19T01:41:36.458Z"],
        ),
        computationTimeMs: field(
          "number",
          "Server-side proof verification duration in milliseconds.",
          [3.284],
          { minimum: 0 },
        ),
        error: field(
          "string",
          "Human-readable verification error message when verification cannot validate the proof. Example: 'Verification key identifier does not match the proof.'.",
          ["Verification key identifier does not match the proof."],
        ),
      },
      required: ["valid", "verifiedAt", "computationTimeMs"],
    },
  },
  {
    name: "proof.status",
    title: "Get Proof Status",
    description:
      "PURPOSE: Retrieves process-memory lifecycle and mesh-quorum status for one proof or snapshot identifier.\nUSAGE: Use exclusively to fetch a single attestation's status by its proofHash or snapshotDigest. Do NOT use to search, filter, or list multiple attestations; use proof.list instead.\nPARAMETERS: Exactly one of proofHash or snapshotDigest must be supplied; proofHash accepts a 64-digit hexadecimal digest with optional 0x prefix or an IPFS CID, while snapshotDigest accepts a decimal field digest, 64-digit hexadecimal digest, or IPFS CID.\nBEHAVIOR: Looks up bounded process-memory status and compares its attestation count with the current mesh quorum threshold; an unknown identifier is reported as pending rather than as not found. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing status as verified, cached, pending, or invalid, plus verifiedAt, attestationCount, and meshQuorum.\nERRORS: -32602 (Invalid Parameters) unless exactly one valid selector is supplied; HTTP 429 (Rate Limit) when the shared limit is exceeded. Unknown identifiers do not produce 404. No 402 payment required.",
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
          "Canonical IPFS CID or hex digest identifier string.",
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
          "Decimal field digest, 64-digit hexadecimal digest, or IPFS CID identifier string.",
          [
            "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
          ],
          {
            pattern:
              "^(?:\\d+|[0-9a-fA-F]{64}|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$",
          },
        ),
      },
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
      "PURPOSE: Lists and filters proof attestations held in the node's bounded process-memory index.\nUSAGE: Use exclusively to query or filter arrays of indexed attestations. Do NOT use to fetch an individual proof or snapshot's status by identifier; use proof.status instead.\nPARAMETERS: limit is an integer from 1 to 100 with default 20; offset is an integer from 0 to 1000 with default 0; status is one of verified, cached, pending, or invalid.\nBEHAVIOR: Filters the process-memory index, orders matches newest first, applies offset and limit, and calculates mesh quorum without durable database writes. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing attestations with proofHash, snapshotDigest, status, submittedAt, attestationCount, and meshQuorum, plus total before pagination.\nERRORS: -32602 (Invalid Parameters) for invalid fields, ranges, or status values; HTTP 429 (Rate Limit) when the shared limit is exceeded. No 402 payment required.",
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
          "Maximum number of records to return (integer, 1-100).",
          [20],
          { minimum: 1, maximum: 100, default: 20 },
        ),
        offset: field(
          "integer",
          "Zero-based pagination skip offset count.",
          [0],
          { minimum: 0, maximum: 1_000, default: 0 },
        ),
        status: field(
          "string",
          "Filter records by attestation lifecycle state: verified, cached, pending, or invalid.",
          ["verified"],
          { enum: [...proofLifecycleStates] },
        ),
      },
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
                  "Canonical IPFS CID or hex digest identifier string.",
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
      "PURPOSE: Verifies Groth16/Poseidon BN254 coordinates, indexes their lifecycle in process memory, and attempts Nostr NIP-78 publication for a valid proof.\nUSAGE: Use to submit proof coordinates for lifecycle lookup and optional Nostr publication. Do NOT use when only validating an encoded proof against telemetry data; use proof.verify instead.\nPARAMETERS: proof is an object containing pi_a as three decimal strings, pi_b as three pairs of decimal strings, and pi_c as three decimal strings; publicSignals is exactly five decimal strings ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest; snapshotDigest accepts a decimal field digest or IPFS CID and, when supplied, must equal publicSignals[4].\nBEHAVIOR: Validates and indexes Groth16/BN254 ZK proof attestations through a bounded process-memory lifecycle; records can be refreshed or evicted, so the index is neither durable nor append-only. Valid proofs may be published as NIP-78 attestations. This MCP API exposes no deletion tool. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing proofHash, status as verified or invalid, submittedAt, and attestationStatus describing Nostr publication or why it was not attempted.\nERRORS: -32602 (Invalid Parameters) for malformed coordinates, signals, fields, or a snapshotDigest mismatch; HTTP 429 (Rate Limit) when the shared limit is exceeded; cryptographic rejection is returned as status invalid and publication failure is reported by attestationStatus. No 402 payment required.",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input payload containing Groth16 proof object and public signals for ingestion and Nostr NIP-78 attestation broadcast.",
      examples: [{
        proof: {
          pi_a: ["1", "2", "1"],
          pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
          pi_c: ["5", "6", "1"],
        },
        publicSignals: ["920000", "1", "1789776000000", "12583", "1"],
        snapshotDigest: "1",
      }],
      additionalProperties: false,
      properties: {
        proof: {
          type: "object",
          description:
            "Groth16/Poseidon zk-SNARK proof coordinates over the BN254 curve.",
          example: {
            pi_a: ["1", "2", "1"],
            pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
            pi_c: ["5", "6", "1"],
          },
          examples: [{
            pi_a: ["1", "2", "1"],
            pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
            pi_c: ["5", "6", "1"],
          }],
          default: {
            pi_a: ["1", "2", "1"],
            pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
            pi_c: ["5", "6", "1"],
          },
          additionalProperties: false,
          properties: {
            pi_a: field(
              "array",
              "Groth16 BN254 proof A projective coordinates.",
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
            pi_b: field(
              "array",
              "Groth16 BN254 proof B projective coordinates.",
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
            pi_c: field(
              "array",
              "Groth16 BN254 proof C projective coordinates.",
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
          required: ["pi_a", "pi_b", "pi_c"],
        },
        publicSignals: field(
          "array",
          "Public signals ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest.",
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
      "PURPOSE: Creates a signed epistemic anchor receipt for agent context grounded in the current Bitcoin tip.\nUSAGE: Use to ground agent context and obtain a verifiable receipt. Do NOT use for raw ZK proof verification; use proof.verify instead.\nPARAMETERS: Accepts contextHash as a 64-character case-insensitive hexadecimal SHA-256 digest, agentId as a trimmed 1-256 character string, and an optional metadata object.\nBEHAVIOR: Validates context and checks Bitcoin tip and signing readiness before requesting payment; after 250-sat L402 settlement, returns a signed receipt without a second HTTP payment. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing receipt with signed payload, Merkle proof, NIP-78 signature, normalized contextHash and agentId, blockHeight, blockHash, and timestamp; verify it through /api/v1/zk/verify.\nERRORS: -32602 (Invalid Parameters) for malformed context, HTTP 402 (Payment Required) with a 250-sat invoice when unpaid, 429 (Rate Limit), or 503 when Bitcoin tip or signing is unavailable.",
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
          "64-character case-insensitive hexadecimal SHA-256 digest string; normalized to lowercase.",
          ["4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f"],
          { pattern: "^[0-9a-fA-F]{64}$", minLength: 64, maxLength: 64 },
        ),
        agentId: field(
          "string",
          "Trimmed client or agent identifier string from 1 to 256 characters.",
          ["research-agent-7"],
          { minLength: 1, maxLength: 256 },
        ),
        metadata: field(
          "object",
          "Key-value JSON object containing arbitrary metadata.",
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
      "PURPOSE: Retrieves current peer topology, propagation, cross-validation, and quorum health for the mesh node.\nUSAGE: Use to inspect peer connectivity and consensus readiness. Do NOT use for individual proof validation or telemetry retrieval; use proof.verify or stratigraphy.get instead.\nPARAMETERS: No input properties are accepted.\nBEHAVIOR: Observes current in-process mesh service metrics without changing proof or telemetry state. Rate limit: 60 req/min per IP shared across /mcp.\nRETURNS: Object containing nodePubkey, activePeerCount, configuredPeerCount, topologyHealth, crossValidationSuccessRate, averagePropagationLatencyMs, and quorumThreshold.\nERRORS: -32602 (Invalid Parameters) when any input property is supplied; HTTP 429 (Rate Limit) when the shared limit is exceeded. No 402 payment required.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "No input parameters required.",
      examples: [{}],
      additionalProperties: false,
      properties: {},
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
];

const mcpToolDefinitions = baseMcpToolDefinitions;

function createBitcoinStratigraphyMcpServer(
  groundReceipt?: Awaited<ReturnType<typeof groundEpistemicContext>>,
) {
  const mesh = createMeshGossipService();
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
      const structuredContent = await submitZkProof(parsed.data);
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
): Promise<void> {
  const server = createBitcoinStratigraphyMcpServer(
    res.locals.epistemicAnchorReceipt as Awaited<ReturnType<typeof groundEpistemicContext>> | undefined,
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
  } = {},
): void {
  const rateLimit = createHttpRateLimitMiddleware(
    createSlidingWindowRateLimiter({ limit: 60, windowMs: 60_000 }),
  );
  const settlementRouter = options.settlementRouter ?? createDefaultMultiSettlementRouter();
  const paidTools = {
    "stratigraphy.list": { amountSats: 10, schema: stratigraphyCatalogInputSchema },
    "proof.list": { amountSats: 10, schema: listProofAttestationsInputSchema },
    "proof.status": { amountSats: 10, schema: proofStatusInputSchema },
    "stratigraphy.get": { amountSats: 250, schema: stratigraphyInputSchema },
    "proof.verify": { amountSats: 250, schema: verifyProofInputSchema },
    "proof.ground": { amountSats: 250, schema: groundContextInputSchema },
    "proof.submit": { amountSats: 250, schema: submitProofInputSchema },
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
    const body = req.body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
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
  }, handleMcpRequest, (_req, res) => {
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