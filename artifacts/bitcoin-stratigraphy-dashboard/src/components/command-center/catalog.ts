// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
/**
 * Static MCP catalog for the homepage Command Center. Names and titles mirror
 * the API's tools/list registry; test/command-center.test.mjs keeps them in
 * lockstep with the server. Prices are never stored here: they are quoted live.
 */

export const MCP_ENDPOINT = "https://bitcoinstratigraphy.com/mcp";
export const NPM_PACKAGE = "@bitcoin-stratigraphy/mcp-server";
export const NPX_INSTALL_COMMAND = `npx -y ${NPM_PACKAGE}`;
export const NPM_PACKAGE_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;

export type McpNamespace = "stratigraphy" | "proof" | "mesh" | "payment" | "workflow";

export interface CanonicalMcpTool {
  name: string;
  title: string;
}

export const MCP_NAMESPACE_SUMMARIES: Readonly<Record<McpNamespace, string>> = {
  workflow: "Deterministic thermodynamic audits with compact boundary proof receipts.",
  stratigraphy:
    "Indexed daily strata: catalog, records, digests, diffs and ranges.",
  proof:
    "Macaroon attenuation, ZK proofs, receipts, OpenTimestamps notarization and grounding.",
  mesh: "Mesh status and telemetry snapshot broadcast.",
  payment: "Live MCP payment terms.",
};

export const CANONICAL_MCP_TOOLS: Readonly<
  Record<McpNamespace, readonly CanonicalMcpTool[]>
> = {
  workflow: [{ name: "workflow.audit_trajectory", title: "Audit Thermodynamic Trajectory" }],
  stratigraphy: [
    { name: "stratigraphy.list", title: "List Stratigraphy Catalog" },
    { name: "stratigraphy.get", title: "Get Bitcoin Stratigraphy" },
    {
      name: "stratigraphy.get_digest",
      title: "Get Compressed Stratigraphy Digest",
    },
    { name: "stratigraphy.get_diff", title: "Compare Stratigraphy Strata" },
    { name: "stratigraphy.get_range", title: "Get Stratigraphy Range" },
  ],
  proof: [
    { name: "proof.list", title: "List Proof Attestations" },
    { name: "proof.verify", title: "Verify Stratigraphy ZK Proof" },
    { name: "proof.submit", title: "Submit ZK Proof" },
    { name: "proof.get_by_hash", title: "Get Proof or Receipt by Hash" },
    {
      name: "proof.notarize",
      title: "Notarize a SHA256 Digest with OpenTimestamps",
    },
    { name: "proof.ground", title: "Ground Agent Context in Bitcoin State" },
    { name: "proof.attenuate", title: "Attenuate a Macaroon" },
  ],
  mesh: [
    { name: "mesh.get_status", title: "Get Mesh Status" },
    { name: "mesh.broadcast", title: "Broadcast Telemetry Snapshot to Mesh" },
  ],
  payment: [{ name: "payment.get_info", title: "Get MCP Payment Information" }],
};

/** Display columns: the two small namespaces share one column. */
export const MCP_NAMESPACE_COLUMNS: readonly (readonly McpNamespace[])[] = [
  ["stratigraphy"],
  ["proof"],
  ["workflow", "mesh", "payment"],
];

export const CANONICAL_MCP_TOOL_NAMES: readonly string[] = Object.values(
  CANONICAL_MCP_TOOLS,
).flatMap((tools) => tools.map((tool) => tool.name));
