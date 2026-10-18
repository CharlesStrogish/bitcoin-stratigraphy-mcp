// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { primaryStratigraphyContracts } from "../services/primaryStratigraphySchemas";

export const AUDIT_TRAJECTORY_DESCRIPTION =
  "A deterministic composite workflow that executes a complete end-to-end thermodynamic audit between fromTarget and toTarget. It automatically calculates signed difficulty deltas, fetches compressed SHA-256 proof receipts, and returns a unified cryptographic report. Use this composite workflow to save LLM context tokens and eliminate multi-step agent orchestration when auditing historical divergence. Use individual stratigraphy or proof tools for single-purpose queries. Paid L402 call: on HTTP 402, pay the invoice and retry with Authorization: L402 <macaroon>:<preimage>.";

export const AUDIT_TRAJECTORY_EXAMPLE = {
  trajectory_deltas: {
    from: {
      height: 919900,
      date: "2026-10-12T00:00:00+00:00",
      target_multiplier: 126,
      network_energy_watts: 1e9,
    },
    to: {
      height: 920000,
      date: "2026-10-13T00:00:00+00:00",
      target_multiplier: 125,
      network_energy_watts: 1.1e9,
    },
    delta: {
      heightDelta: 100,
      multiplierDelta: -1,
      percentageChange: "-0.79%",
      energyWattsDelta: 1e8,
      timeSpanDays: 1,
    },
  },
  cryptographic_proofs: {
    from: {
      h: 919900,
      ts: "2026-10-12T00:00:00+00:00",
      tm: 126,
      hash: "ab".repeat(32),
      source: "archived_snapshot",
      receipt: null,
    },
    to: {
      h: 920000,
      ts: "2026-10-13T00:00:00+00:00",
      tm: 125,
      hash: "cd".repeat(32),
      source: "live_snapshot",
      receipt: null,
    },
  },
};

const property = (
  type: string | string[],
  description: string,
  example: unknown,
) => ({ type, description, examples: [example] });
const boundary = {
  type: "object",
  additionalProperties: false,
  description:
    "Compact exact-byte snapshot digest and its own minimal archived receipt, or null for an unattested live snapshot. Hashes alone are not proofs of Bitcoin inclusion.",
  examples: [AUDIT_TRAJECTORY_EXAMPLE.cryptographic_proofs.to],
  properties: {
    h: property("integer", "Actual captured Bitcoin height.", 920000),
    ts: property(
      "string",
      "Snapshot observation UTC time.",
      "2026-10-13T00:00:00+00:00",
    ),
    tm: property(
      ["number", "null"],
      "Hal Finney Horizon valuation multiple, or null without fiat data.",
      125,
    ),
    hash: {
      ...property(
        "string",
        "SHA-256 of the same exact archived bytes used by get_digest, or canonical live JSON.",
        "ab".repeat(32),
      ),
      pattern: "^[0-9a-f]{64}$",
    },
    source: {
      ...property(
        "string",
        "Distinguishes an archived snapshot from unarchived live telemetry.",
        "live_snapshot",
      ),
      enum: ["archived_snapshot", "live_snapshot"],
    },
    receipt: {
      type: ["object", "null"],
      additionalProperties: false,
      description:
        "References the selected boundary's existing OTS receipt only; no unrelated archive, raw snapshot, or proof bytes. Null when no archived receipt covers this boundary.",
      examples: [null],
      properties: {
        snapshot_sha256: property(
          "string",
          "SHA-256 of the exact archived snapshot.",
          "ab".repeat(32),
        ),
        ots_sha256: property(
          "string",
          "SHA-256 of the current detached OTS bytes.",
          "cd".repeat(32),
        ),
        proof_status: property(
          "string",
          "Actual archived receipt verification status; calendar acceptance is not Bitcoin confirmation.",
          "pending_calendar",
        ),
        ots_download_url: property(
          "string",
          "URL of the selected boundary's detached receipt.",
          "/agent-api/historical-proof/2026-10-12/ots",
        ),
      },
      required: [
        "snapshot_sha256",
        "ots_sha256",
        "proof_status",
        "ots_download_url",
      ],
    },
  },
  required: ["h", "ts", "tm", "hash", "source", "receipt"],
};

export const AUDIT_TRAJECTORY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Single-query composite of existing get_diff arithmetic and get_digest boundary fingerprints. No intermediate records or full telemetry/proof-byte envelopes. The pipeline's available deltas are valuation-multiple, height, energy and time changes, not an invented network-difficulty series.",
  examples: [AUDIT_TRAJECTORY_EXAMPLE],
  properties: {
    trajectory_deltas: {
      type: "object",
      additionalProperties: false,
      description:
        "The same signed arithmetic returned by stratigraphy.get_diff, evaluated against one fixed live snapshot and cached archive bytes.",
      examples: [AUDIT_TRAJECTORY_EXAMPLE.trajectory_deltas],
      properties: Object.fromEntries(
        ["from", "to", "delta"].map((key) => [
          key,
          primaryStratigraphyContracts["stratigraphy.get_diff"].outputSchema
            .properties[key],
        ]),
      ),
      required: ["from", "to", "delta"],
    },
    cryptographic_proofs: {
      type: "object",
      additionalProperties: false,
      description:
        "Minimal proof references and SHA-256 fingerprints for the exact two selected boundary records. Live fingerprints are not archived OTS proofs.",
      examples: [AUDIT_TRAJECTORY_EXAMPLE.cryptographic_proofs],
      properties: { from: boundary, to: boundary },
      required: ["from", "to"],
    },
  },
  required: ["trajectory_deltas", "cryptographic_proofs"],
};
