// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
/** The established tool names/prices remain fixed; these schemas describe live values. */
const attribute = (type: string | string[], description: string, example: unknown) => ({
  type, description, example, examples: [example],
});

const proofExample = {
  date: "2026-10-12",
  snapshot_filename: "snapshot_2026-10-12.json",
  ots_filename: "snapshot_2026-10-12.json.ots",
  snapshot_json: "{\"block_height\":920000}",
  snapshot_sha256: "ab".repeat(32),
  ots_sha256: "cd".repeat(32),
  ots_proof_base64: "AQID",
  proof_status: "bitcoin_attestation_present_unverified",
  snapshot_download_url: "/agent-api/historical-proof/2026-10-12/snapshot",
  ots_download_url: "/agent-api/historical-proof/2026-10-12/ots",
  bundle_download_url: "/agent-api/historical-proof/2026-10-12/download",
};
const liveExample = {
  block_height: 920000,
  observed_at_utc: "2026-10-12T00:00:00+00:00",
  btc_price_usd: 80000,
  hal_finney_horizon_target_usd: 10000000,
  hal_finney_horizon_multiple: 125,
  attribution: "Projected by Hal Finney on January 10, 2009 ($10M per coin valuation under total global wealth absorption).",
  network_hashrate_h_s: 1e21,
  network_hashrate_th_s: 1e9,
  network_energy_watts: 15e9,
  efficiency_baseline_j_th: 15,
  snapshot_age_seconds: 2,
};
const liveSchema = {
  type: "object", additionalProperties: true,
  description: "Fresh, complete pipeline snapshot. Energy is estimated from hashrate / 1e12 * assumed 15 J/TH; the $10M divided by USD price multiple is not a time forecast.",
  properties: Object.fromEntries(Object.entries(liveExample).map(([key, value]) =>
    [key, attribute(typeof value === "number" ? "number" : "string",
      `Current pipeline ${key}; not a value reconstructed from the historical video index.`, value)])),
  required: Object.keys(liveExample),
  examples: [liveExample],
};
const proofSchema = {
  type: "object", additionalProperties: false,
  description: "Exact Object Storage JSON bytes and current .ots bytes, including in-place Bitcoin upgrades; proof binds snapshot_json, never changing live_metrics.",
  properties: Object.fromEntries(Object.entries(proofExample).map(([key, value]) =>
    [key, attribute("string", `Cloud historical proof ${key}.`, value)])),
  required: Object.keys(proofExample),
  examples: [proofExample],
};
const common = {
  live_metrics: liveSchema,
  historical_proofs: {
    type: "array", items: proofSchema,
    description: "All archived snapshots returned by this call, or latest available archive for a live-only result.",
    examples: [[proofExample]],
  },
  proofAvailable: attribute("boolean", "True only if an archived JSON/OTS pair was returned.", true),
  archive_state: attribute("string", "available or no_archives; no synthetic receipt is created.", "available"),
  proof_coverage: attribute("string", "Only exact archived JSON is covered by each receipt, never live metrics.", "Exact archived snapshot_json only; changing live_metrics are not covered."),
};
const sharedExample = {
  live_metrics: liveExample, historical_proofs: [proofExample],
  proofAvailable: true, archive_state: "available",
  proof_coverage: "Exact archived snapshot_json only; changing live_metrics are not covered.",
};

function contract(description: string, example: Record<string, unknown>, properties: Record<string, unknown>) {
  return {
    description,
    outputSchema: {
      type: "object", additionalProperties: false, description, properties,
      required: Object.keys(example), examples: [example],
    },
  };
}

export const primaryStratigraphyContracts: Record<string, ReturnType<typeof contract>> = {
  "stratigraphy.list": contract(
    "Free, metadata-only discovery of real UTC archive bounds and current Bitcoin tip height; no paid snapshot or proof bytes. Historical height fields are actual captured heights.",
    {
      totalSnapshots: 1, oldestBlock: 919900, newestBlock: 919900, liveBlockHeight: 920000,
      availableMetrics: Object.keys(liveExample),
      dateBounds: { startDate: "2026-10-12", endDate: "2026-10-12" },
      efficiency_baseline_j_th: 15, attribution: liveExample.attribution, proofArchiveCount: 1,
      source: "stratigraphy_pipeline.py + Replit Object Storage",
    },
    {
      totalSnapshots: attribute("integer", "Number of JSON snapshots captured in Object Storage.", 1),
      oldestBlock: attribute(["integer", "null"], "Real block height of the oldest archive, or null.", 919900),
      newestBlock: attribute(["integer", "null"], "Real block height of the newest archive, or null.", 919900),
      liveBlockHeight: attribute("integer", "Current live tip from the pipeline, not an indexed archive height.", 920000),
      availableMetrics: { type: "array", items: attribute("string", "One live pipeline field name.", "network_energy_watts"), description: "Actual fields in the live pipeline model.", examples: [Object.keys(liveExample)] },
      dateBounds: { type: "object", properties: {
        startDate: attribute(["string", "null"], "Earliest captured UTC date, or null.", "2026-10-12"),
        endDate: attribute(["string", "null"], "Latest captured UTC date, or null.", "2026-10-12"),
      }, required: ["startDate", "endDate"], description: "Actual captured archive UTC date bounds.", examples: [{ startDate: "2026-10-12", endDate: "2026-10-12" }] },
      efficiency_baseline_j_th: attribute("integer", "Assumed fixed hardware efficiency used by live power estimate.", 15),
      attribution: attribute("string", "Verbatim historical attribution of the Hal Finney Horizon.", liveExample.attribution),
      proofArchiveCount: attribute("integer", "Number of complete JSON/OTS archive pairs.", 1),
      source: attribute("string", "Authoritative pipeline and Object Storage origins.", "stratigraphy_pipeline.py + Replit Object Storage"),
    },
  ),
  "stratigraphy.get": contract(
    "Paid, full fresh pipeline telemetry and exact selected historical Object Storage JSON/.ots receipts; records contain live or archived pipeline snapshots, never video-index data.",
    { records: [liveExample], ...sharedExample },
    { records: { type: "array", items: liveSchema, description: "Selected actual live or UTC-archived complete pipeline snapshots.", examples: [[liveExample]] }, ...common },
  ),
  "stratigraphy.get_digest": contract(
    "Paid SHA-256 fingerprints of actual cloud JSON bytes or current live pipeline JSON, with full live telemetry and associated archived receipts alongside them.",
    { result: "HEIGHT:920000|DATE:2026-10-12T00:00:00+00:00|TM:125|HASH:" + "ab".repeat(32), ...sharedExample },
    { result: { type: ["string", "array", "object"], description: "compact text, minimal tuple, kv object, or arrays for bounded date ranges; hash is SHA-256 of exact archived JSON when available.", examples: ["HEIGHT:920000|DATE:2026-10-12T00:00:00+00:00|TM:125|HASH:" + "ab".repeat(32)] }, ...common },
  ),
  "stratigraphy.get_diff": contract(
    "Paid signed deltas between real-height live/archived snapshots, including 15 J/TH power change; includes live metrics and exact archived proof bytes.",
    { from: { height: 919900, date: "2026-10-12T00:00:00+00:00", target_multiplier: 126, network_energy_watts: 1e9 },
      to: { height: 920000, date: liveExample.observed_at_utc, target_multiplier: 125, network_energy_watts: 15e9 },
      delta: { heightDelta: 100, multiplierDelta: -1, percentageChange: "-0.79%", energyWattsDelta: 14e9, timeSpanDays: 1 }, ...sharedExample },
    { from: { type: "object", description: "Real captured from-target values.", examples: [{ height: 919900 }] },
      to: { type: "object", description: "Real captured to-target values.", examples: [{ height: 920000 }] },
      delta: { type: "object", description: "Signed arithmetic deltas; watts derive from the assumed 15 J/TH baseline.", examples: [{ heightDelta: 100 }] }, ...common },
  ),
  "stratigraphy.get_range": contract(
    "Paid contiguous captured UTC snapshot fingerprints bounded by actual Bitcoin heights/dates, plus full live metrics and matching upgraded archived receipts.",
    { range: { start: "2026-10-12", end: "latest" }, count: 1, format: "compact", records: ["HEIGHT:920000|DATE:2026-10-12T00:00:00+00:00|TM:125|HASH:" + "ab".repeat(32)], ...sharedExample },
    { range: { type: "object", description: "Requested inclusive real height/date bounds.", examples: [{ start: "2026-10-12", end: "latest" }] },
      count: attribute("integer", "Number of actual records returned.", 1),
      format: attribute("string", "compact, minimal, or kv response format.", "compact"),
      records: { type: "array", description: "Selected actual snapshot summaries, not a synthetic daily index.", items: { type: ["string", "array", "object"], description: "One requested compact, minimal or kv summary.", examples: ["HEIGHT:920000|DATE:2026-10-12T00:00:00+00:00|TM:125|HASH:" + "ab".repeat(32)] }, examples: [["HEIGHT:920000|DATE:2026-10-12T00:00:00+00:00|TM:125|HASH:" + "ab".repeat(32)]] }, ...common },
  ),
};
