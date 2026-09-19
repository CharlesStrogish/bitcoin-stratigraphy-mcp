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
    z.string(),
    "Bitcoin mining difficulty epoch progress formatted as a percentage.",
    ["73.42%"],
  ),
  thermodynamic_signal: documented(
    z.string(),
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
    z.string(),
    "Poseidon field digest of the canonical snapshot payload.",
    ["1534979302823651498736582947365829473658294736582947365829473658294"],
  ),
  thermodynamicHash: documented(
    z.string(),
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
    "Integer satoshi valuation committed into the proof.",
    [12583],
  ),
}).describe("Public Groth16/Poseidon inputs committed by the SNARK");

const snapshotSchema = documented(
  z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())),
  ]),
  "Snapshot payload whose canonical digest and semantic fields must match the proof.",
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
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Exact ISO calendar date string formatted as YYYY-MM-DD. Example: '2026-09-19'.",
  ),
  blockHeight: z.number().int().positive().optional().describe(
    "Exact indexed Bitcoin block height (integer > 0). Example: 850000.",
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
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "Inclusive UTC lower date bound formatted as YYYY-MM-DD.",
  ),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
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

const verifyProofInputSchema = z.object({
  proof: z.string().describe(
    "Base64url-encoded Groth16 proof emitted by this API.",
  ),
  publicInputs: publicInputsSchema,
  verificationKeyId: z.string().describe(
    "SHA-256 identifier of the expected verification key.",
  ),
  data: snapshotSchema,
}).strict().describe(
  "Proof, public inputs, verification key, and bound snapshot for a stateless dry run.",
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
  limit: z.number().int().min(1).max(100).default(10).describe(
    "Optional integer maximum number of attestation records to return (integer, 1 to 100). Defaults to 10. Example: 20.",
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
      z.string().describe("Decimal BN254 field coordinate in the proof A point."),
    ).length(3).describe(
      "Three projective coordinates for the Groth16 proof A point.",
    ),
    pi_b: z.array(
      z.array(
        z.string().describe(
          "Decimal BN254 field coordinate in the proof B point.",
        ),
      ).length(2).describe("Pair of BN254 extension-field coordinates."),
    ).length(3).describe(
      "Three extension-field coordinate pairs for the Groth16 proof B point.",
    ),
    pi_c: z.array(
      z.string().describe("Decimal BN254 field coordinate in the proof C point."),
    ).length(3).describe(
      "Three projective coordinates for the Groth16 proof C point.",
    ),
  }).strict().describe(
    "Groth16 BN254 proof object containing pi_a, pi_b, and pi_c.",
  ),
  publicSignals: z.array(
    z.string().describe("Decimal public signal committed by the proof."),
  ).length(5).describe(
    "Five public signals ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest.",
  ),
  snapshotDigest: z.string().min(1).optional().describe(
    "Optional snapshot CID or digest that must equal the fifth public signal.",
  ),
}).strict().describe(
  "Fresh Groth16 proof coordinates and public signals for verification, indexing, and publication.",
);

const meshStatusInputSchema = z.object({}).strict().describe(
  "Input options for querying P2P mesh status and node health.",
);

const field = (
  type: string | string[],
  description: string,
  examples: unknown[],
  extra: Record<string, unknown> = {},
) => ({ type, description, example: examples[0], examples, ...extra });

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
  description: "Public Groth16/Poseidon inputs committed by the SNARK.",
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
    ),
    thermodynamicHash: field(
      "string",
      "Poseidon field hash of thermodynamic telemetry values.",
      ["782365829473658294736582947365829473658294736582947365829473658294"],
    ),
    timestamp: field(
      "integer",
      "Unix timestamp in milliseconds committed into the proof.",
      [1789776000000],
      { minimum: 0 },
    ),
    valuationSat: field(
      "integer",
      "Integer satoshi valuation committed into the proof.",
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

const mcpToolDefinitions = [
  {
    name: "get_bitcoin_stratigraphy",
    title: "Get Bitcoin Stratigraphy",
    description:
      "Query validated thermodynamic Bitcoin Stratigraphy telemetry by recent-day count, exact date, exact indexed block height, or inclusive date/block range, with optional metric projection. Use this tool when you need raw historical telemetry or time-series ranges. Do NOT use for catalog discovery; use list_stratigraphy_catalog instead. Do NOT use for proof verification, submission, or lifecycle operations; use verify_zk_proof, submit_zk_proof, or get_proof_status instead. Behavior: Pure read-only and idempotent query with zero server-side state modification; responses are deterministically cached.",
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
          { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        ),
        blockHeight: field(
          "integer",
          "Exact indexed Bitcoin block height (integer > 0). Example: 850000.",
          [850000],
          { minimum: 1 },
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
          { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        ),
        endDate: field(
          "string",
          "Inclusive upper date bound formatted as YYYY-MM-DD in UTC. Must not precede startDate and may not be combined with legacy selectors.",
          ["2026-09-18"],
          { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
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
    name: "list_stratigraphy_catalog",
    title: "List Stratigraphy Catalog",
    description:
      "Discover available stratigraphy datasets, date ranges, total recorded epochs, block height bounds, snapshot CIDs, and available telemetry metrics. Use this tool first when you need to discover available dataset bounds and snapshot CIDs. Do NOT use for fetching raw time-series records; use get_bitcoin_stratigraphy instead.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "No parameters are required to discover the catalog.",
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
    name: "verify_zk_proof",
    title: "Verify Stratigraphy ZK Proof",
    description:
      "Execute active, stateless Groth16/Poseidon cryptographic math verification on an incoming proof payload. Use this tool strictly for instant computational verification. Do NOT use for status lookups (use get_proof_status instead) or browsing attestation logs (use list_proof_attestations instead).",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Proof, public inputs, verification key, and bound snapshot.",
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
          "Base64url-encoded Groth16 proof emitted by this API.",
          ["eyJwaV9hIjpbIjEyMyIsIjQ1NiIsIjEiXX0"],
        ),
        publicInputs: publicInputsJsonSchema,
        verificationKeyId: field(
          "string",
          "SHA-256 identifier of the expected verification key.",
          ["sha256:4c095e183ea45a9d"],
        ),
        data: field(
          ["object", "array"],
          "Snapshot payload whose digest and semantic fields must match the proof.",
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
          "ISO 8601 timestamp recording when verification completed.",
          ["2026-09-19T01:41:36.458Z"],
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
    name: "get_proof_status",
    title: "Get Proof Status",
    description:
      "Query the detailed attestation lifecycle and Nostr publication state of ONE specific known proof hash or snapshot digest. Use this tool when you already hold a proof hash or CID. Do NOT use for listing multiple proofs (use list_proof_attestations instead) or performing math verification (use verify_zk_proof instead). Behavior: Pure read-only and idempotent lookup with zero server-side state modification; queries indexed attestation memory and Nostr event log.",
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
        ),
        snapshotDigest: field(
          "string",
          "64-character hexadecimal SHA-256 digest string or IPFS CID of the targeted zk-SNARK proof attestation. Example: '186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e'.",
          [
            "186b68214d3bfa5566dde64f3c66746e1bad3fdad7a01e158e6e8a730023302e",
          ],
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
    name: "list_proof_attestations",
    title: "List Proof Attestations",
    description:
      "Browse and discover recent zk-SNARK proof CIDs, NIP-78 attestation records, and indexed verification logs without needing prior knowledge of a proof hash or digest. Use this tool during discovery to list historical attestations. Do NOT use for querying a specific proof hash (use get_proof_status instead) or executing stateless verification (use verify_zk_proof instead). Behavior: Pure read-only and idempotent listing with zero server-side state modification; returns newest-first deduplicated records bounded to 1,000 entries.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Input options for listing and discovering historical zk-SNARK proof attestations.",
      examples: [{ limit: 20, status: "verified" }],
      additionalProperties: false,
      properties: {
        limit: field(
          "integer",
          "Optional integer maximum number of attestation records to return (integer, 1 to 100). Defaults to 10. Example: 20.",
          [20],
          { minimum: 1, maximum: 100, default: 10 },
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
    name: "submit_zk_proof",
    title: "Submit ZK Proof",
    description:
      "Submit a new Groth16/Poseidon zk-SNARK proof payload and public signals to the data engine. Use this tool when you need to submit fresh proofs for verification, lifecycle indexing, and Nostr NIP-78 relay broadcast. Do NOT use for dry-run verification; use verify_zk_proof instead.",
    annotations: submissionToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Groth16 BN254 proof coordinates, five ordered public signals, and an optional matching snapshot digest.",
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
            "Groth16 BN254 proof object containing pi_a, pi_b, and pi_c curve-point coordinates as decimal strings.",
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
          additionalProperties: false,
          properties: {
            pi_a: field(
              "array",
              "Three decimal-string projective coordinates for the Groth16 proof A point.",
              [["1", "2", "1"]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "string",
                  "Decimal BN254 field coordinate in the A point.",
                  ["1"],
                ),
              },
            ),
            pi_b: field(
              "array",
              "Three pairs of decimal-string extension-field coordinates for the Groth16 proof B point.",
              [[["1", "2"], ["3", "4"], ["1", "0"]]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "array",
                  "Pair of decimal BN254 extension-field coordinates.",
                  [["1", "2"]],
                  {
                    minItems: 2,
                    maxItems: 2,
                    items: field(
                      "string",
                      "Decimal BN254 field coordinate in the B point.",
                      ["1"],
                    ),
                  },
                ),
              },
            ),
            pi_c: field(
              "array",
              "Three decimal-string projective coordinates for the Groth16 proof C point.",
              [["5", "6", "1"]],
              {
                minItems: 3,
                maxItems: 3,
                items: field(
                  "string",
                  "Decimal BN254 field coordinate in the C point.",
                  ["5"],
                ),
              },
            ),
          },
          required: ["pi_a", "pi_b", "pi_c"],
        },
        publicSignals: field(
          "array",
          "Exactly five decimal strings ordered as blockHeight, thermodynamicHash, timestamp, valuationSat, and snapshotDigest.",
          [["920000", "1", "1789776000000", "12583", "1"]],
          {
            minItems: 5,
            maxItems: 5,
            items: field(
              "string",
              "Decimal public signal committed by the Groth16 proof.",
              ["920000"],
            ),
          },
        ),
        snapshotDigest: field(
          "string",
          "Optional telemetry snapshot CID or digest to index with the proof; when provided it must equal the fifth public signal.",
          ["1"],
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
    name: "get_mesh_status",
    title: "Get Mesh Status",
    description:
      "Retrieve P2P peer discovery, cross-validation, quorum, consensus topology, and L402 health. Use this tool when you need P2P topology, peer count, or L402 health checks. Do NOT use for telemetry or proofs; use get_bitcoin_stratigraphy, list_stratigraphy_catalog, verify_zk_proof, submit_zk_proof, or get_proof_status instead. Behavior: Pure read-only and idempotent system health query with zero server-side state modification; reflects live P2P node mesh telemetry.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "Input options for querying P2P mesh status and node health.",
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
    if (request.params.name === "get_bitcoin_stratigraphy") {
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
    if (request.params.name === "list_stratigraphy_catalog") {
      if (!z.object({}).strict().safeParse(args).success) {
        throw new McpError(ErrorCode.InvalidParams, "Catalog takes no arguments");
      }
      const structuredContent = await stratigraphyCatalog();
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
    if (request.params.name === "verify_zk_proof") {
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
    if (request.params.name === "get_proof_status") {
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
    if (request.params.name === "list_proof_attestations") {
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
    if (request.params.name === "submit_zk_proof") {
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
    if (request.params.name === "get_mesh_status") {
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