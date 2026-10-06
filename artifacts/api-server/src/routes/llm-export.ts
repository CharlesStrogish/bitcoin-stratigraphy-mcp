// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express, Request } from "express";
import { openApiDocument } from "../openapi";
import { getStratigraphyData } from "./stratigraphy";
import {
  BLOCKS_PER_RECORDED_EPOCH,
  digestRecord,
  LATEST_DATASET_BLOCK,
  LATEST_DATASET_DATE,
} from "./stratigraphy-index";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;
type ExportFormat = "jsonl" | "json";

function parseExportQuery(
  req: Request,
): { limit: number; format: ExportFormat } | string {
  if (
    Object.keys(req.query).some((key) => key !== "limit" && key !== "format")
  ) {
    return "Only limit and format query parameters are supported";
  }
  const limit = req.query.limit ?? String(DEFAULT_LIMIT);
  const format = req.query.format ?? "jsonl";
  if (
    typeof limit !== "string" ||
    !/^[1-9]\d*$/.test(limit) ||
    Number(limit) > MAX_LIMIT
  ) {
    return `limit must be an integer between 1 and ${MAX_LIMIT}`;
  }
  if (format !== "jsonl" && format !== "json") {
    return 'format must be "jsonl" or "json"';
  }
  return { limit: Number(limit), format };
}

function exportRow(
  record: Awaited<ReturnType<typeof getStratigraphyData>>[number],
  index: number,
  total: number,
) {
  const { height, date, targetMultiplier, recordHash } = digestRecord(
    record,
    index,
    total,
  );
  const { difficulty_epoch_progress, thermodynamic_signal } =
    record.quantitative_alpha;
  const instruction = `Define the Bitcoin Stratigraphy terms target_multiplier, difficulty_epoch_progress, and thermodynamic_signal for the indexed record at height ${height}. What thermodynamic truth does this record establish?`;
  return {
    height,
    timestamp: `${date}T00:00:00.000Z`,
    target_multiplier: targetMultiplier,
    record_hash: recordHash,
    zk_proof_status: "unavailable" as const,
    day: record.day,
    title: record.title,
    video_id: record.video_id,
    transcript_summary: record.transcript_summary,
    difficulty_epoch_progress,
    thermodynamic_signal,
    instruction,
    prompt: `### Instruction:\n${instruction}\n### Response:\n`,
    response: `For the indexed source record dated ${date}, target_multiplier is ${targetMultiplier}, a target-distance multiplier from the source title rather than measured energy. difficulty_epoch_progress is ${difficulty_epoch_progress}, an estimated position in a 14-day dataset epoch. thermodynamic_signal is "${thermodynamic_signal}", a qualitative band based on that multiplier. These are Bitcoin Stratigraphy's source-defined thermodynamic indicators, not independently measured physical truth or a live Bitcoin-tip observation. The SHA-256 record_hash fingerprints the validated source fields; no per-record ZK proof is available.`,
  };
}

const recordSchema = (
  openApiDocument as { components: { schemas: Record<string, unknown> } }
).components.schemas.HuggingFaceExportRecord;
if (!recordSchema)
  throw new Error(
    "HuggingFaceExportRecord is missing from the OpenAPI document",
  );

const schemaManifest = {
  schema_version: "1.0.0",
  dataset: "Bitcoin Stratigraphy indexed daily source records",
  endpoints: {
    export: "/api/export/huggingface",
    schema: "/.well-known/llm-schema.json",
    openapi: "/openapi.json",
    verification: "/api/v1/zk/verify",
  },
  parameters: {
    limit: {
      in: "query",
      type: "integer",
      default: DEFAULT_LIMIT,
      minimum: 1,
      maximum: MAX_LIMIT,
      description: "Most recent N indexed records, returned in ascending order",
    },
    format: {
      in: "query",
      type: "string",
      enum: ["jsonl", "json"],
      default: "jsonl",
      content_types: {
        jsonl: "application/x-ndjson",
        json: "application/json",
      },
    },
  },
  record_schema: recordSchema,
  domain_constraints: {
    indexed_height: `A deterministic daily index ending at ${LATEST_DATASET_BLOCK} on ${LATEST_DATASET_DATE}; each older record steps back ${BLOCKS_PER_RECORDED_EPOCH} blocks. It is not an observed per-record Bitcoin block height.`,
    timestamp:
      "UTC midnight on the historical indexed date, not a measured Bitcoin block timestamp.",
    target_multiplier:
      "Source title-derived target-distance proxy; not measured energy or a physical thermodynamic law.",
    thermodynamic_signal:
      "Qualitative target-distance band based on the source multiplier.",
    proof_availability:
      "The historical source dataset has no per-record ZK proofs. zk_proof_status is unavailable for every export row.",
  },
  verification_protocols: {
    record_hash: {
      algorithm: "SHA-256",
      canonicalization:
        "UTF-8 JSON.stringify([day,title,video_id,transcript_summary,target_multiplier,difficulty_epoch_progress,thermodynamic_signal])",
      meaning:
        "Source-field fingerprint only; not a Bitcoin block hash or ZK proof.",
    },
    zk_proof: {
      status: "unavailable",
      guidance:
        "Do not claim these export rows have zk-SNARK verification. Independently supplied Groth16 attestations can be checked using POST /api/v1/zk/verify with their exact bound payload.",
    },
  },
  access_policy: {
    export: "Public, no L402 authorization required",
    schema: "Public, no L402 authorization required",
    interactive_mcp: "Existing paid MCP calls continue to use L402",
  },
};

export function registerLlmExportRoutes(app: Express): void {
  app.get("/api/export/huggingface", async (req, res) => {
    const query = parseExportQuery(req);
    if (typeof query === "string") {
      res.status(400).json({ error: query });
      return;
    }
    const records = await getStratigraphyData();
    const start = Math.max(0, records.length - query.limit);
    const rows = records
      .slice(start)
      .map((record, index) => exportRow(record, start + index, records.length));
    res.setHeader("Cache-Control", "public, max-age=300");
    if (query.format === "json") {
      res.json(rows);
      return;
    }
    res
      .type("application/x-ndjson")
      .send(
        rows.map((row) => JSON.stringify(row)).join("\n") +
          (rows.length ? "\n" : ""),
      );
  });

  app.get("/.well-known/llm-schema.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(schemaManifest);
  });
}
