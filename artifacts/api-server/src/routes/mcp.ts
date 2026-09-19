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

const thermodynamicMetricNames = [
  "target_multiplier",
  "difficulty_epoch_progress",
  "thermodynamic_signal",
] as const;

const stratigraphyInputSchema = z.object({
  days: z.number().int().min(1).max(422).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  blockHeight: z.number().int().nonnegative().optional(),
  metrics: z.array(z.enum(thermodynamicMetricNames)).min(1).refine(
    (values) => new Set(values).size === values.length,
    "metrics must contain unique values",
  ).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startBlock: z.number().int().nonnegative().optional(),
  endBlock: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(10),
}).strict();

const verifyProofInputSchema = z.object({
  proof: z.string(),
  publicInputs: publicInputsSchema,
  verificationKeyId: z.string(),
  data: snapshotSchema,
}).strict();

const proofStatusInputSchema = z.object({
  proofHash: z.string().min(1).optional(),
  snapshotDigest: z.string().min(1).optional(),
}).strict().refine(
  (input) =>
    (input.proofHash === undefined) !== (input.snapshotDigest === undefined),
  "Provide exactly one of proofHash or snapshotDigest",
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
      "Query validated thermodynamic Bitcoin Stratigraphy telemetry by recent-day count, exact date, exact indexed block height, or inclusive date/block range, with optional metric projection.",
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
          "Legacy selector for the number of most recent daily snapshots to return. Must be an integer from 1 through 422 and cannot be combined with date, blockHeight, or range selectors.",
          [10],
          { minimum: 1, maximum: 422 },
        ),
        date: field(
          "string",
          "Legacy selector for one exact dataset date formatted as YYYY-MM-DD in UTC. It cannot be combined with days, blockHeight, or range selectors.",
          ["2026-09-18"],
          { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        ),
        blockHeight: field(
          "integer",
          "Legacy selector for one exact non-negative height in the deterministic daily block index. It cannot be combined with days, date, or range selectors; an unindexed height returns no records.",
          [920000],
          { minimum: 0 },
        ),
        metrics: field(
          "array",
          "Optional projection of thermodynamic fields returned inside quantitative_alpha. Supply one or more unique metric names; omitted metrics are excluded, while omitting this parameter returns all thermodynamic metrics.",
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
      "Discover available stratigraphy datasets, date ranges, total recorded epochs, block height bounds, and available telemetry metrics without requiring prior knowledge of exact snapshot parameters.",
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
      "Verify a Groth16/Poseidon BN254 proof and its binding to a supplied snapshot payload.",
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
      "Query the cryptographic attestation status, verification cache history, and Nostr NIP-78 publication state of a previously submitted zk-SNARK proof digest or snapshot CID.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description:
        "Exactly one proof hash or snapshot digest identifying a previously submitted proof.",
      examples: [{ proofHash: "0x1a2b3c..." }],
      additionalProperties: false,
      properties: {
        proofHash: field(
          "string",
          "SHA-256 digest of the submitted proof string, formatted with a 0x prefix. Provide this or snapshotDigest, but not both.",
          ["0x1a2b3c..."],
        ),
        snapshotDigest: field(
          "string",
          "Snapshot content identifier or decimal Poseidon-bound snapshot digest recorded in the proof public inputs. Provide this or proofHash, but not both.",
          ["0x1a2b3c..."],
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
    name: "get_mesh_status",
    title: "Get Mesh Status",
    description:
      "Retrieve P2P peer discovery, cross-validation, quorum, and consensus topology health.",
    annotations: readOnlyToolAnnotations,
    inputSchema: {
      type: "object",
      description: "No parameters are required for the mesh status query.",
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
    if (request.params.name === "get_mesh_status") {
      if (!z.object({}).strict().safeParse(args).success) {
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