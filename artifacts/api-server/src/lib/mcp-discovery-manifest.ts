/** Public discovery document; version strings do not configure MCP negotiation. */
export const mcpDiscoveryManifest = {
  $schema: "https://modelcontextprotocol.io/schemas/discovery/v1.json",
  name: "bitcoin-stratigraphy-mcp",
  version: "2.0.0",
  description:
    "Bitcoin Stratigraphy: 15 live MCP tools across 4 namespaces, including OpenTimestamps notarization, an interactive Developer Portal and Live Tool Explorer, Python SDK/client and CrewAI, LangChain and AutoGen cookbooks, and L402 Lightning micropayments with free batch POST pricing.",
  author: {
    name: "Charles R. Strogish",
    url: "https://bitcoin-stratigraphy-dashboard.replit.app",
  },
  homepage: "https://bitcoin-stratigraphy-dashboard.replit.app",
  documentation: "https://bitcoin-stratigraphy-dashboard.replit.app/docs",
  links: {
    documentation: "https://bitcoin-stratigraphy-dashboard.replit.app/docs",
    cookbooks: "https://bitcoin-stratigraphy-dashboard.replit.app/cookbooks",
    python_sdk:
      "https://bitcoin-stratigraphy-dashboard.replit.app/cookbooks/l402_client.py",
    pricing: "https://bitcoin-stratigraphy-dashboard.replit.app/api/v1/cost",
  },
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
        count: 15,
        namespaces: ["stratigraphy", "proof", "mesh", "payment"],
      },
      prompts: true,
      resources: true,
    },
  },
  pricing: {
    model: "L402-sats-per-query",
    cost_discovery_endpoint: "/api/v1/cost",
    cost_discovery_methods: ["GET", "POST"],
    batch_quotes_create_invoices: false,
  },
  verification: {
    zk_proving_system: "Groth16",
    curve: "BN254",
    time_anchor: "OpenTimestamps (Bitcoin Block Headers)",
    mesh_consensus: "Nostr (NIP-01, NIP-78)",
  },
} as const;
