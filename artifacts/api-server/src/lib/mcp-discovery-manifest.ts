/** Public discovery document; version strings do not configure MCP negotiation. */
export const mcpDiscoveryManifest = {
  $schema: "https://modelcontextprotocol.io/schemas/discovery/v1.json",
  name: "bitcoin-stratigraphy-mcp",
  version: "2.0.0",
  description:
    "Enterprise L402 data vending engine serving real-time thermodynamic Bitcoin telemetry, Groth16 ZK-SNARK verification, Nostr P2P mesh consensus, and agent context grounding across 14 MCP tools.",
  author: {
    name: "Charles R. Strogish",
    url: "https://bitcoin-stratigraphy-dashboard.replit.app",
  },
  homepage: "https://bitcoin-stratigraphy-dashboard.replit.app",
  mcp: {
    version: "2024-11-25",
    transports: [
      {
        type: "streamable-http",
        endpoint: "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
      },
    ],
    capabilities: {
      tools: {
        count: 14,
        namespaces: ["stratigraphy", "proof", "mesh", "payment"],
      },
      prompts: true,
      resources: true,
    },
  },
  pricing: {
    model: "L402-sats-per-query",
    cost_discovery_endpoint: "/api/v1/cost",
  },
  verification: {
    zk_proving_system: "Groth16",
    curve: "BN254",
    time_anchor: "OpenTimestamps (Bitcoin Block Headers)",
    mesh_consensus: "Nostr (NIP-01, NIP-78)",
  },
} as const;