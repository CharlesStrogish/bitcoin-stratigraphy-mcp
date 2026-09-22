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
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { createMeshGossipService } from "../services/meshGossipService";
import {
  getZkProofStatus,
  listZkProofAttestations,
  submitZkProof,
  verifyZkProofForSnapshot,
} from "../services/zkProofService";
import { getStratigraphyData } from "./stratigraphy";

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
    "Non-negative integer Bitcoin block height committed into the proof. Minimum 0. Example: 920000.",
    [920000],
  ),
  snapshotDigest: documented(
    z.string().min(1),
    "Required decimal string Poseidon field digest of the canonical snapshot payload. Example: '1534979302823651498736582947365829473658294736582947365829473658294'.",
    ["1534979302823651498736582947365829473658294736582947365829473658294"],
  ),
  thermodynamicHash: documented(
    z.string().min(1),
    "Required decimal string Poseidon field hash of the thermodynamic telemetry values. Example: '782365829473658294736582947365829473658294736582947365829473658294'.",
    ["782365829473658294736582947365829473658294736582947365829473658294"],
  ),
  timestamp: documented(
    z.number().int().nonnegative(),
    "Non-negative integer Unix timestamp in milliseconds committed into the proof. Minimum 0. Example: 1789776000000.",
    [1789776000000],
  ),
  valuationSat: documented(
    z.number().int().nonnegative(),
    "Non-negative integer satoshi valuation committed into the proof. Minimum 0. Example: 12583.",
    [12583],
  ),
}).strict().describe(
  "Required object containing exactly five typed public statement inputs committed by the Groth16/Poseidon proof.",
);

const snapshotSchema = documented(
  z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())),
  ]),
  "Required telemetry snapshot object or array of objects whose canonical digest and semantic fields must match the proof. Example: [{'block':{'height':920000},'observed_at':'2026-09-19T00:00:00.000Z','thermodynamic':{'target_multiplier':125.83}}].",
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
    "Number of recent days of telemetry to fetch (integer, 1 to 365). Defaults to 30. Example: 7.",
  ),
  date: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Exact ISO calendar date string formatted as YYYY-MM-DD. Example: '2026-09-19'.",
  ),
  blockHeight: z.number().int().min(0).optional().describe(
    "Exact indexed Bitcoin block height (non-negative integer). Example: 850000.",
  ),
  metrics: z.array(
    z.enum(thermodynamicMetricNames).describe(
      "Thermodynamic metric name to include in each returned record.",
    ),
  ).min(1).refine(
    (values) => new Set(values).size === values.length,
    "metrics must contain unique values",
  ).optional().describe(
    "Optional array of telemetry metric key strings to project. Defaults to all fields. Example: ['hashrate', 'energy_joules'].",
  ),
  startDate: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Inclusive UTC lower date bound formatted as YYYY-MM-DD.",
  ),
  endDate: z.string().min(1).regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Inclusive UTC upper date bound formatted as YYYY-MM-DD.",
  ),
  startBlock: z.number().int().nonnegative().optional().describe(
    "Inclusive non-negative lower bound of the daily block-height index.",
  ),
  endBlock: z.number().int().nonnegative().optional().describe(
    "Inclusive non-negative upper bound of the daily block-height index.",
  ),
  limit: z.number().int().min(1).max(100).default(10).describe(
    "Maximum number of matching snapshots to return, from 1 through 100.",
  ),
}).strict().describe("Validated raw stratigraphy telemetry query parameters.");

const stratigraphyCatalogInputSchema = z.object({}).strict().describe(
  "No input parameters required.",
);

const verifyProofInputSchema = z.object({
  proof: z.string().min(1).describe(
    "Required base64url-encoded Groth16/Poseidon BN254 proof string emitted by this API, without padding. Example: 'eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0'.",
  ),
  publicInputs: publicInputsSchema,
  verificationKeyId: z.string().min(1).describe(
    "Required SHA-256 verification-key identifier string using the 'sha256:' prefix. Example: 'sha256:4c095e183ea45a9d'.",
  ),
  data: snapshotSchema,
}).strict().describe(
  "Input arguments containing Groth16 proof coordinates and public signals for stateless elliptic curve verification.",
);

const proofStatusInputSchema = z.object({
  proofHash: z.string().min(1).optional().describe(
    "64-character hexadecimal SHA-256 digest string or IPFS CID of the targeted zk-SNARK proof attestation. Example: '186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e'.",
  ),
  snapshotDigest: z.string().min(1).optional().describe(
    "64-character hexadecimal SHA-256 digest string or IPFS CID of the targeted zk-SNARK proof attestation. Example: '186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e'.",
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
    "Maximum number of attestation records to return (integer, 1 to 100). Defaults to 20.",
  ),
  offset: z.number().int().min(0).max(1_000).default(0).describe(
    "Zero-based number of matching attestation records to skip before returning the page (integer, 0 to 1000). Defaults to 0.",
  ),
  status: z.enum(proofLifecycleStates).optional().describe(
    "Optional attestation lifecycle status filter string (e.g., 'verified', 'pending', 'rejected'). Defaults to returning records of all statuses. Example: 'verified'.",
  ),
}).strict().describe(
  "Input options for listing and discovering historical zk-SNARK proof attestations.",
);

const submitProofInputSchema = z.object({
  proof: z.object({
    pi_a: z.array(
      z.string().min(1).describe(
        "Decimal string BN254 scalar-field coordinate in proof point A. Example: '10823'.",
      ),
    ).length(3).describe(
      "Required 3-element array of decimal string field elements representing the Groth16 BN254 proof A projective point. Example: ['10823', '49102', '1'].",
    ),
    pi_b: z.array(
      z.array(
        z.string().min(1).describe(
          "Decimal string BN254 extension-field coordinate in proof point B. Example: '331'.",
        ),
      ).length(2).describe(
        "Required 2-element array of decimal string BN254 extension-field coordinates. Example: ['112', '331'].",
      ),
    ).length(3).describe(
      "Required 3x2 nested array of decimal string field elements representing the Groth16 BN254 proof B projective point. Example: [['112', '331'], ['981', '771'], ['1', '0']].",
    ),
    pi_c: z.array(
      z.string().min(1).describe(
        "Decimal string BN254 scalar-field coordinate in proof point C. Example: '554'.",
      ),
    ).length(3).describe(
      "Required 3-element array of decimal string field elements representing the Groth16 BN254 proof C projective point. Example: ['554', '882', '1'].",
    ),
  }).strict().describe(
    `Groth16/Poseidon zk-SNARK proof object containing pi_a (3-element array), pi_b (3x2 nested array), and pi_c (3-element array) BN254 elliptic curve projective points as decimal string field elements. Example: {"pi_a":["10823","49102","1"],"pi_b":[["112","331"],["981","771"],["1","0"]],"pi_c":["554","882","1"]}.`,
  ),
  publicSignals: z.array(
    z.string().min(1).describe(
      "Decimal string scalar field element in the BN254 curve modulo space. Example: '920000'.",
    ),
  ).length(5).describe(
    "Required array of exactly 5 public signal strings representing scalar field elements in BN254 curve modulo space, ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest. Example: ['920000', '1', '1789776000000', '12583', '1'].",
  ),
  snapshotDigest: z.string().min(1).optional().describe(
    "Optional non-empty telemetry snapshot CID or decimal Poseidon digest string that must equal the fifth public signal. No default. Example: '1'.",
  ),
}).strict().describe(
  "Input payload containing Groth16 proof object and public signals for ingestion and Nostr NIP-78 attestation broadcast.",
);

const meshStatusInputSchema = z.object({}).strict().describe(
  "No input parameters required.",
);

const groundContextInputSchema = z.object({
  contextHash: z.string().regex(/^[0-9a-fA-F]{64}$/).describe(
    "SHA-256 context digest as exactly 64 hexadecimal characters.",
  ),
  agentId: z.string().trim().min(1).max(256).describe(
    "Stable identifier of the agent requesting the epistemic anchor.",
  ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    "Optional JSON object with caller-supplied context metadata.",
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
    "Required object containing exactly five typed public statement inputs committed by the Groth16/Poseidon proof.",
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
      "Non-negative integer Bitcoin block height committed into the proof. Minimum 0. Example: 920000.",
      [920000],
      { minimum: 0 },
    ),
    snapshotDigest: field(
      "string",
      "Required decimal string Poseidon field digest of the canonical snapshot payload. Example: '1534979302823651498736582947365829473658294736582947365829473658294'.",
      ["1534979302823651498736582947365829473658294736582947365829473658294"],
      { minLength: 1 },
    ),
    thermodynamicHash: field(
      "string",
      "Required decimal string Poseidon field hash of the thermodynamic telemetry values. Example: '782365829473658294736582947365829473658294736582947365829473658294'.",
      ["782365829473658294736582947365829473658294736582947365829473658294"],
      { minLength: 1 },
    ),
    timestamp: field(
      "integer",
      "Non-negative integer Unix timestamp in milliseconds committed into the proof. Minimum 0. Example: 1789776000000.",
      [1789776000000],
      { minimum: 0 },
    ),
    valuationSat: field(
      "integer",
      "Non-negative integer satoshi valuation committed into the proof. Minimum 0. Example: 12583.",
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
      "PURPOSE: Retrieve validated thermodynamic Bitcoin stratigraphy telemetry records by day count, specific date, block height, or inclusive range.\nUSAGE: Invoke to query historical block-space and thermodynamic proof metrics; run stratigraphy.list first to discover bounds. Do NOT use for ZK proof validation (use proof.verify).\nPARAMETERS: Accepts at most one exact selector—days, date, or blockHeight—or inclusive startDate/endDate and startBlock/endBlock range bounds; optional metrics controls projection and limit bounds the result count. Conflicting or invalid arguments are rejected, with schema failures returning MCP error -32602.\nBEHAVIOR: Read-only and idempotent with zero state mutation or external network writes. Data access may use the server's deterministic telemetry cache; unindexed bounds return an empty records array.\nRETURNS: JSON object containing a records array of matching telemetry entries and projected quantitative metrics.",
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
          "Number of recent days of telemetry to fetch (integer, 1 to 365). Defaults to 30. Example: 7.",
          [7],
          { minimum: 1, maximum: 365, default: 30 },
        ),
        date: field(
          "string",
          "Exact ISO calendar date string formatted as YYYY-MM-DD. Example: '2026-09-19'.",
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
          "Exact indexed Bitcoin block height (non-negative integer). Example: 850000.",
          [850000],
          { minimum: 0 },
        ),
        metrics: field(
          "array",
          "Optional array of telemetry metric key strings to project. Defaults to all fields. Example: ['hashrate', 'energy_joules'].",
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
          "Inclusive lower date bound formatted as YYYY-MM-DD in UTC. May be combined with endDate and block bounds, but not with days, date, or blockHeight.",
          ["2026-09-01"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        endDate: field(
          "string",
          "Inclusive upper date bound formatted as YYYY-MM-DD in UTC. Must not precede startDate and may not be combined with legacy selectors.",
          ["2026-09-18"],
          {
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            minLength: 1,
          },
        ),
        startBlock: field(
          "integer",
          "Inclusive non-negative lower bound of the deterministic daily block-height index. May be combined with endBlock and date bounds, but not with legacy selectors.",
          [910000],
          { minimum: 0 },
        ),
        endBlock: field(
          "integer",
          "Inclusive non-negative upper bound of the deterministic daily block-height index. Must be at least startBlock and may not be combined with legacy selectors.",
          [920000],
          { minimum: 0 },
        ),
        limit: field(
          "integer",
          "Maximum number of matching snapshots returned after filtering. It defaults to 10 when omitted and must be an integer from 1 through 100.",
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
      "PURPOSE: List available Bitcoin stratigraphy metric layers, date bounds, block bounds, and historical archive coverage.\nUSAGE: Invoke to discover valid telemetry bounds and metric keys before calling stratigraphy.get. Do NOT invoke to fetch full telemetry records (use stratigraphy.get).\nPARAMETERS: Accepts zero parameters ({}); no input arguments are required. Passing excess arguments returns MCP error -32602.\nBEHAVIOR: Read-only and idempotent catalog lookup over the server's telemetry index with zero state mutation or external network writes.\nRETURNS: JSON object containing totalSnapshots, oldestBlock, newestBlock, availableMetrics, and dateBounds.",
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
      "PURPOSE: Perform stateless synchronous cryptographic verification of a Groth16/Poseidon BN254 zero-knowledge proof against public inputs and snapshot data.\nUSAGE: Invoke for immediate proof validation without lifecycle indexing. Do NOT invoke for indexed submission and Nostr publication (use proof.submit) or historical status lookup (use proof.status).\nPARAMETERS: Requires a non-empty base64url proof string, publicInputs with blockHeight, snapshotDigest, thermodynamicHash, timestamp, and valuationSat, a non-empty verificationKeyId, and bound snapshot data. Missing or invalid fields return MCP error -32602.\nBEHAVIOR: Performs cryptographic verification in memory; read-only and idempotent with zero lifecycle-index mutation or external network writes.\nRETURNS: JSON object containing valid, verifiedAt, computationTimeMs, and an optional error message.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input arguments containing Groth16 proof coordinates and public signals for stateless elliptic curve verification.",
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
          "Required base64url-encoded Groth16/Poseidon BN254 proof string emitted by this API, without padding. Example: 'eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0'.",
          ["eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0"],
          { minLength: 1 },
        ),
        publicInputs: publicInputsJsonSchema,
        verificationKeyId: field(
          "string",
          "Required SHA-256 verification-key identifier string using the 'sha256:' prefix. Example: 'sha256:4c095e183ea45a9d'.",
          ["sha256:4c095e183ea45a9d"],
          { minLength: 1 },
        ),
        data: field(
          ["object", "array"],
          "Required telemetry snapshot object or array of objects whose canonical digest and semantic fields must match the proof. Example: [{'block':{'height':920000},'observed_at':'2026-09-19T00:00:00.000Z','thermodynamic':{'target_multiplier':125.83}}].",
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
          "ISO 8601 timestamp recording when verification completed.",
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
          "Optional human-readable verification error message string when verification cannot validate the proof. Example: 'Verification key identifier does not match the proof.'.",
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
      "PURPOSE: Retrieve lifecycle status and attestation history for one submitted zero-knowledge proof.\nUSAGE: Invoke when a proof hash or snapshot digest is known. Do NOT invoke for stateless inline proof validation (use proof.verify) or proof discovery (use proof.list).\nPARAMETERS: Requires exactly one non-empty selector: proofHash or snapshotDigest. Supplying neither, both, or an invalid value returns MCP error -32602.\nBEHAVIOR: Read-only and idempotent lookup against the in-memory lifecycle index; does not re-trigger cryptographic verification, mutate state, or perform network writes.\nRETURNS: JSON object containing status, verifiedAt, attestationCount, and meshQuorum.",
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
          "64-character hexadecimal SHA-256 digest string or IPFS CID of the targeted zk-SNARK proof attestation. Example: '186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e'.",
          [
            "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
          ],
          { minLength: 1 },
        ),
        snapshotDigest: field(
          "string",
          "64-character hexadecimal SHA-256 digest string or IPFS CID of the targeted zk-SNARK proof attestation. Example: '186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e'.",
          [
            "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
          ],
          { minLength: 1 },
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
          "ISO 8601 timestamp of the latest verification-state observation.",
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
      "PURPOSE: List indexed zero-knowledge proof attestations and snapshot digests known to the node.\nUSAGE: Invoke to discover previously submitted proof hashes before querying detailed state. Do NOT use for real-time validation (use proof.verify).\nPARAMETERS: Accepts optional limit (integer 1-100, default 20), offset (integer 0-1000, default 0), and lifecycle status filter. Invalid argument names, values, or types return MCP error -32602.\nBEHAVIOR: Read-only and idempotent scan of the bounded in-memory attestation index with zero state mutation or external network writes.\nRETURNS: JSON object containing an attestations array and total matching record count.",
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
          "Maximum number of attestation records to return (integer, 1 to 100). Defaults to 20.",
          [20],
          { minimum: 1, maximum: 100, default: 20 },
        ),
        offset: field(
          "integer",
          "Zero-based number of matching attestation records to skip before returning the page (integer, 0 to 1000). Defaults to 0.",
          [0],
          { minimum: 0, maximum: 1_000, default: 0 },
        ),
        status: field(
          "string",
          "Optional attestation lifecycle status filter string (e.g., 'verified', 'pending', 'rejected'). Defaults to returning records of all statuses. Example: 'verified'.",
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
                  "Lowercase 0x-prefixed SHA-256 fingerprint of the indexed proof.",
                  [
                    "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
                  ],
                ),
                snapshotDigest: field(
                  "string",
                  "Snapshot CID or decimal Poseidon digest bound to the indexed proof.",
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
                  "ISO 8601 timestamp when this proof entered the lifecycle index.",
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
      "PURPOSE: Synchronously verify and index a Groth16/Poseidon BN254 zero-knowledge proof with optional Nostr attestation publication.\nUSAGE: Invoke when a newly generated proof should enter the node's lifecycle index. Do NOT invoke for stateless transient verification (use proof.verify).\nPARAMETERS: Requires a proof object with pi_a, pi_b, and pi_c arrays plus exactly five publicSignals strings; snapshotDigest is optional but must match publicSignals[4] when supplied. Invalid structure returns MCP error -32602.\nBEHAVIOR: Synchronously verifies the proof, mutates the in-memory lifecycle index, and may publish a Nostr attestation when relay signing is configured; repeated submissions can create external relay side effects.\nRETURNS: JSON object containing proofHash, status, submittedAt, and attestationStatus.",
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
            `Groth16/Poseidon zk-SNARK proof object containing pi_a (3-element array), pi_b (3x2 nested array), and pi_c (3-element array) BN254 elliptic curve projective points as decimal string field elements. Example: {"pi_a":["10823","49102","1"],"pi_b":[["112","331"],["981","771"],["1","0"]],"pi_c":["554","882","1"]}.`,
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
              "Required 3-element array of decimal string field elements representing the Groth16 BN254 proof A projective point. Example: ['10823', '49102', '1'].",
              [["1", "2", "1"]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "string",
                  "Decimal string BN254 scalar-field coordinate in proof point A. Example: '10823'.",
                  ["10823"],
                  { minLength: 1 },
                ),
              },
            ),
            pi_b: field(
              "array",
              "Required 3x2 nested array of decimal string field elements representing the Groth16 BN254 proof B projective point. Example: [['112', '331'], ['981', '771'], ['1', '0']].",
              [[["1", "2"], ["3", "4"], ["1", "0"]]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "array",
                  "Required 2-element array of decimal string BN254 extension-field coordinates. Example: ['112', '331'].",
                  [["112", "331"]],
                  {
                    minItems: 2,
                    maxItems: 2,
                    items: field(
                      "string",
                      "Decimal string BN254 extension-field coordinate in proof point B. Example: '331'.",
                      ["331"],
                      { minLength: 1 },
                    ),
                  },
                ),
              },
            ),
            pi_c: field(
              "array",
              "Required 3-element array of decimal string field elements representing the Groth16 BN254 proof C projective point. Example: ['554', '882', '1'].",
              [["5", "6", "1"]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "string",
                  "Decimal string BN254 scalar-field coordinate in proof point C. Example: '554'.",
                  ["554"],
                  { minLength: 1 },
                ),
              },
            ),
          },
          required: ["pi_a", "pi_b", "pi_c"],
        },
        publicSignals: field(
          "array",
          "Required array of exactly 5 public signal strings representing scalar field elements in BN254 curve modulo space, ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest. Example: ['920000', '1', '1789776000000', '12583', '1'].",
          [["920000", "1", "1789776000000", "12583", "1"]],
          {
            minItems: 5,
            maxItems: 5,
            items: field(
              "string",
              "Decimal string scalar field element in the BN254 curve modulo space. Example: '920000'.",
              ["920000"],
              { minLength: 1 },
            ),
          },
        ),
        snapshotDigest: field(
          "string",
          "Optional non-empty telemetry snapshot CID or decimal Poseidon digest string that must equal the fifth public signal. The schema default is '1'.",
          ["1"],
          { minLength: 1 },
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
          "Lowercase 0x-prefixed SHA-256 fingerprint of the canonical submitted proof object.",
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
          "ISO 8601 timestamp when the data engine accepted the submission.",
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
    name: "zk.ground",
    title: "Ground Agent Context in Bitcoin State",
    description:
      "PURPOSE: Initiate a paid epistemic-context grounding request anchored to the current Bitcoin tip and signed by the server's Nostr identity.\nUSAGE: Use this tool when an agent needs a context hash bound to current Bitcoin height/hash. Use proof.verify for existing Groth16 proofs, proof.submit for lifecycle indexing, and stratigraphy.get for historical telemetry. Grounding is not performed for free through MCP; complete the 5-sat L402 flow at POST /api/v1/zk/ground with the same request.\nPARAMETERS: contextHash is a 64-character SHA-256 hex digest, agentId is a non-empty identifier up to 256 characters, and metadata is an optional JSON object. Invalid parameters return MCP -32602.\nBEHAVIOR: This MCP call is a side-effect-free payment router and never fabricates an unpaid anchor. The HTTP endpoint validates input, fetches current Bitcoin height/hash, canonicalizes the state with a server timestamp, computes SHA-256 block commitments and a Merkle root, and signs with NIP-78 before issuing or redeeming the L402 challenge; successful settlement records revenue.\nRETURNS: JSON {status:402,error:'payment_required',endpoint:'/api/v1/zk/ground',amountSats:5,verificationEndpoint:'/api/v1/zk/verify',request:{contextHash,agentId,metadata}}. The paid HTTP response instead returns {receipt}, whose attestation-shaped receipt includes contextHash, blockHeight, blockHash, merkleRoot, timestamp, and nostrSignature.\nERRORS: Invalid MCP arguments return -32602. The HTTP route returns 400 for invalid payloads, 503 when Bitcoin-tip lookup or signing preflight fails before any challenge, 402 after successful preflight until paid, 429 with Retry-After when rate limited, 500 for missing server settlement/signing configuration, and 502 when invoice creation or payment verification fails.",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Epistemic context grounding request routed to the paid HTTP boundary.",
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
          "Required SHA-256 digest of the agent context, encoded as exactly 64 hexadecimal characters.",
          ["4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f"],
          { pattern: "^[0-9a-fA-F]{64}$", minLength: 64, maxLength: 64 },
        ),
        agentId: field(
          "string",
          "Required stable caller-controlled agent identifier from 1 through 256 characters.",
          ["research-agent-7"],
          { minLength: 1, maxLength: 256 },
        ),
        metadata: field(
          "object",
          "Optional JSON object carrying non-secret caller metadata to bind into the signed anchor.",
          [{ topic: "difficulty-adjustment" }],
          { additionalProperties: true },
        ),
      },
      required: ["contextHash", "agentId"],
    },
    outputSchema: {
      type: "object",
      description: "L402 payment routing response for epistemic grounding.",
      examples: [{
        status: 402,
        error: "payment_required",
        endpoint: "/api/v1/zk/ground",
        amountSats: 5,
        verificationEndpoint: "/api/v1/zk/verify",
        request: {
          contextHash:
            "4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f",
          agentId: "research-agent-7",
          metadata: { topic: "difficulty-adjustment" },
        },
      }],
      additionalProperties: false,
      properties: {
        status: field("integer", "HTTP-equivalent payment-required status.", [402], {
          const: 402,
        }),
        error: field("string", "Stable payment-required error code.", [
          "payment_required",
        ], { const: "payment_required" }),
        endpoint: field("string", "Paid HTTP endpoint that performs grounding.", [
          "/api/v1/zk/ground",
        ]),
        amountSats: field("integer", "Fixed grounding price in satoshis.", [5], {
          const: 5,
        }),
        verificationEndpoint: field(
          "string",
          "Public endpoint that verifies the returned receipt unchanged.",
          ["/api/v1/zk/verify"],
        ),
        request: field(
          "object",
          "Validated request to submit to the paid HTTP endpoint.",
          [{
            contextHash:
              "4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f",
            agentId: "research-agent-7",
            metadata: { topic: "difficulty-adjustment" },
          }],
          { additionalProperties: true },
        ),
      },
      required: [
        "status",
        "error",
        "endpoint",
        "amountSats",
        "verificationEndpoint",
        "request",
      ],
    },
  },
  {
    name: "mesh.status",
    title: "Get Mesh Status",
    description:
      "PURPOSE: Retrieve node peer-connectivity metrics, cross-validation success rates, propagation latency, and topology health.\nUSAGE: Invoke to inspect mesh readiness before proof operations. Do NOT invoke for ZK proof validation (use proof.verify) or historical data queries (use stratigraphy.get).\nPARAMETERS: Accepts zero parameters ({}); no input arguments are required. Passing excess arguments returns MCP error -32602.\nBEHAVIOR: Read-only and idempotent in-memory status calculation with zero state mutation or external network writes.\nRETURNS: JSON object containing nodePubkey, activePeerCount, configuredPeerCount, topologyHealth, crossValidationSuccessRate, averagePropagationLatencyMs, and quorumThreshold.",
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

const toolDescriptionAdditions: Record<string, string> = {
  "stratigraphy.get":
    "ROUTING GUIDELINES: Use this tool when you need actual historical telemetry rows selected by date, day count, block height, range, or metric. Do NOT use this tool to discover valid bounds or metric names; use stratigraphy.list instead. Do NOT use it to validate a ZK proof; use proof.verify instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {records:Array<{day:number,title:string,video_id:string,transcript_summary:string,quantitative_alpha:{target_multiplier:number,difficulty_epoch_progress:string,thermodynamic_signal:string}}>}.\nERROR & SECURITY BOUNDARIES: Unknown properties, invalid types, out-of-range values, conflicting selectors, and reversed ranges return MCP error -32602 or a tool error with {isError:true,content:[{type:'text',text:string}]}; unindexed valid bounds return {records:[]}. This read-only tool never issues or accepts a 402 L402 challenge, never returns paid data, and never fabricates records.",
  "stratigraphy.list":
    "ROUTING GUIDELINES: Use this tool when valid date bounds, block bounds, archive coverage, or metric names are unknown. Do NOT use this tool to fetch telemetry rows; use stratigraphy.get instead. Do NOT use it to inspect proof records; use proof.list instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {totalSnapshots:number,oldestBlock:number,newestBlock:number,availableMetrics:string[],dateBounds:{startDate:string,endDate:string}}.\nERROR & SECURITY BOUNDARIES: The only valid input is {}; any property or malformed input returns MCP error -32602. Catalog failures return a tool error with {isError:true,content:[{type:'text',text:string}]} rather than partial data. This read-only tool never issues or accepts a 402 L402 challenge and exposes only catalog metadata.",
  "proof.verify":
    "ROUTING GUIDELINES: Use this tool when you need stateless cryptographic validation of an existing Groth16/Poseidon proof. Do NOT use this tool to index or broadcast a proof; use proof.submit instead. Do NOT use it to create a SHA-256/Nostr epistemic receipt; use zk.ground instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {valid:boolean,verifiedAt:string,computationTimeMs:number,error?:string}.\nERROR & SECURITY BOUNDARIES: Missing properties, unknown properties, malformed base64url proof data, invalid public inputs, invalid verification-key IDs, or unbound snapshot data return MCP error -32602; cryptographic, key, tampering, or semantic mismatches return {valid:false,verifiedAt:string,computationTimeMs:number,error:string}; verifier-capacity failures return a tool error with {isError:true,content:[{type:'text',text:string}]}. This read-only tool never issues or accepts a 402 L402 challenge and does not index caller data.",
  "proof.status":
    "ROUTING GUIDELINES: Use this tool when a proof hash or snapshot digest is already known and you need its indexed lifecycle state. Do NOT use this tool to discover proof identifiers; use proof.list instead. Do NOT use it for fresh cryptographic validation; use proof.verify instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {status:'verified'|'cached'|'pending'|'invalid',verifiedAt:string,attestationCount:number,meshQuorum:boolean}.\nERROR & SECURITY BOUNDARIES: Input must contain exactly one non-empty proofHash or snapshotDigest; unknown properties, invalid types, both selectors, or neither selector return MCP error -32602. Unknown valid identifiers return {status:'pending',verifiedAt:string,attestationCount:0,meshQuorum:false}. This read-only tool never issues or accepts a 402 L402 challenge and does not re-run or mutate proof verification.",
  "proof.list":
    "ROUTING GUIDELINES: Use this tool when you need to discover indexed proof hashes, snapshot digests, or lifecycle records. Do NOT use this tool for one known proof's detailed state; use proof.status instead. Do NOT use it for cryptographic validation; use proof.verify instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {attestations:Array<{proofHash:string,snapshotDigest:string,status:string,submittedAt:string,attestationCount:number,meshQuorum:boolean}>,total:number}.\nERROR & SECURITY BOUNDARIES: Unknown properties, invalid types, limit outside 1-100, offset outside 0-1000, or unsupported status values return MCP error -32602; an empty index returns {attestations:[],total:0}. This read-only tool never issues or accepts a 402 L402 challenge and returns only bounded lifecycle metadata.",
  "proof.submit":
    "ROUTING GUIDELINES: Use this tool when a Groth16/Poseidon proof must be verified, indexed, and optionally broadcast as a Nostr attestation. Do NOT use this tool for side-effect-free validation; use proof.verify instead. Do NOT use it merely to query an indexed proof; use proof.status instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {proofHash:string,status:'verified'|'invalid',submittedAt:string,attestationStatus:'broadcast_confirmed'|'broadcast_failed'|'not_configured'|'not_broadcast_invalid_proof'}.\nERROR & SECURITY BOUNDARIES: Unknown properties, malformed proof coordinates, arrays of incorrect dimensions, non-string field elements, signal counts other than five, or a supplied snapshotDigest that differs from publicSignals[4] return MCP error -32602. Invalid proofs return status:'invalid' and are never represented as verified; relay failures are reported in attestationStatus rather than hiding proof status. This mutating tool never issues or accepts a 402 L402 challenge; callers must account for indexing and optional external relay side effects.",
  "zk.ground":
    "ROUTING GUIDELINES: Use this tool when an agent needs a SHA-256 context digest routed to paid Bitcoin-tip grounding and Nostr signing. Do NOT use this tool to validate an existing Groth16 proof; use proof.verify instead. Do NOT use it to retrieve historical telemetry; use stratigraphy.get instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {status:402,error:'payment_required',endpoint:'/api/v1/zk/ground',amountSats:5,verificationEndpoint:'/api/v1/zk/verify',request:{contextHash:string,agentId:string,metadata:object}}. After payment, the HTTP endpoint returns JSON object: {receipt:{contextHash:string,blockHeight:number,blockHash:string,merkleRoot:string,timestamp:string,nostrSignature:string}}.\nERROR & SECURITY BOUNDARIES: MCP input requires exactly a 64-hex-character contextHash, a trimmed agentId of 1-256 characters, and optional object metadata; unknown properties or invalid values return MCP error -32602. MCP performs no grounding and returns only the fixed 402 routing payload. POST /api/v1/zk/ground requires the matching 5-sat L402 challenge and paid authorization; it returns HTTP 400 for invalid input, 402 with the challenge until paid, 429 with Retry-After for rate limits, 500 for missing settlement/signing configuration, 502 for invoice or payment-verification failure, and 503 for Bitcoin-tip or signing-preflight failure. Receipts must be verified unchanged at POST /api/v1/zk/verify.",
  "mesh.status":
    "ROUTING GUIDELINES: Use this tool when you need peer connectivity, quorum readiness, cross-validation rate, propagation latency, or topology health. Do NOT use this tool to determine proof validity; use proof.verify instead. Do NOT use it for relay circuit and process health; use GET /api/v1/system/health instead.\nRETURN JSON PAYLOAD SHAPE: Returns JSON object: {nodePubkey:string,activePeerCount:number,configuredPeerCount:number,topologyHealth:string,crossValidationSuccessRate:number,averagePropagationLatencyMs:number,quorumThreshold:number}.\nERROR & SECURITY BOUNDARIES: The only valid input is {}; any property or malformed input returns MCP error -32602. Isolated or degraded topology is returned explicitly in the typed payload rather than converted into a false healthy state; internal calculation failures return a tool error with {isError:true,content:[{type:'text',text:string}]}. This read-only tool never issues or accepts a 402 L402 challenge and does not mutate peer state.",
};

const mcpToolDefinitions = baseMcpToolDefinitions.map((tool) => ({
  ...tool,
  description:
    `${tool.description}${toolDescriptionAdditions[tool.name] ? `\n${toolDescriptionAdditions[tool.name]}` : ""}`,
}));

function createBitcoinStratigraphyMcpServer() {
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
      const { days, date } = parsed.data;
      if (days !== undefined && date !== undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide either days or date, not both.",
            },
          ],
        };
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
    if (request.params.name === "zk.ground") {
      const parsed = groundContextInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Invalid epistemic grounding request",
        );
      }
      const structuredContent = {
        status: 402,
        error: "payment_required",
        endpoint: "/api/v1/zk/ground",
        amountSats: 5,
        verificationEndpoint: "/api/v1/zk/verify",
        request: {
          ...parsed.data,
          contextHash: parsed.data.contextHash.toLowerCase(),
        },
      };
      return {
        isError: true,
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
  const server = createBitcoinStratigraphyMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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

export function registerMcpRoute(app: Express): void {
  app.all("/mcp", handleMcpRequest);
}