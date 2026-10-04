import type { Express } from "express";
import { mcpToolPrices } from "../lib/mcp-pricing";
import { ENGINE_DESCRIPTION, MCP_TOOL_GROUPS } from "../lib/engine-metadata";
import { mcpDiscoveryManifest } from "../lib/mcp-discovery-manifest";

/** Static Smithery discovery must not require an MCP connection or tool execution. */
export const smitheryServerCard = {
  name: "bitcoin-stratigraphy-mcp",
  displayName: "Bitcoin Stratigraphy Data Engine",
  description: "Provides thermodynamic data, proof verification, and L402 payments.",
  version: "1.0.0",
  url: "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
} as const;

const baseServerCard = {
  name: "bitcoin-stratigraphy",
  description: ENGINE_DESCRIPTION,
  transport: {
    type: "streamable-http",
    url: "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
  },
  capabilities: {
    toolGroups: MCP_TOOL_GROUPS,
    tags: [
      "zero-knowledge-data-integrity",
      "zk-snarks",
      "groth16",
      "poseidon",
      "l402",
      "multi-asset-payments",
      "nostr",
      "nip-78",
    ],
    tools: [
      {
        name: "stratigraphy.get",
        annotations: {
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
          },
        },
      },
      {
        name: "stratigraphy.get_digest",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          l402: { amountSats: 250 },
        },
      },
      {
        name: "stratigraphy.get_diff",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          l402: { amountSats: 250 },
        },
      },
      {
        name: "stratigraphy.get_range",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          l402: { amountSats: 250 },
        },
      },
      {
        name: "stratigraphy.list",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "proof.attenuate",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "proof.verify",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "proof.get_by_hash",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          l402: { amountSats: 250 },
        },
      },
      {
        name: "proof.list",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "proof.submit",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "proof.ground",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
          l402: {
            endpoint: "POST /mcp",
            amountSats: 250,
          },
          attestationType: "Signed-Bitcoin-Tip-Anchor",
          verificationEndpoint: "POST /api/v1/zk/verify",
          verificationInput:
            "Send { attestation: receipt } for an agent-context receipt. For a dataset receipt, parse receipt.attestation.proofPayload and send { attestation: parsedReceipt }. This verifies the signed receipt, not a Groth16 proof or Bitcoin proof-of-work.",
        },
      },
      {
        name: "payment.get_info",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "mesh.get_status",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "mesh.broadcast",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
          l402: {
            amountSats: 250,
          },
        },
      },
    ],
  },
} as const;

export const mcpServerCard = {
  ...baseServerCard,
  capabilities: {
    ...baseServerCard.capabilities,
    tools: baseServerCard.capabilities.tools.map((tool) => ({
      ...tool,
      annotations: {
        ...tool.annotations,
        l402: {
          amountSats: mcpToolPrices[tool.name as keyof typeof mcpToolPrices],
          ...(mcpToolPrices[tool.name as keyof typeof mcpToolPrices] > 0 ? { batchSize: 100, batchHeader: "X-L402-Batch-Size" } : {}),
        },
      },
    })),
  },
};

export const glamaConnector = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  claim: "glama_claim_4N7ubcwaG0adHJjd-Go2ue11blsBugXo",
} as const;

export function registerMcpServerCardRoute(app: Express): void {
  app.get("/.well-known/mcp.json", (_req, res): void => {
    res.set("Access-Control-Allow-Origin", "*");
    // Wildcard public discovery is intentionally not a credentialed CORS route.
    res.removeHeader("Access-Control-Allow-Credentials");
    res.status(200).json(mcpDiscoveryManifest);
  });

  for (const path of [
    "/smithery-verification",
    "/.well-known/smithery-verification",
  ]) {
    app.get(path, (_req, res): void => {
      res.set("Cache-Control", "no-store");
      res.status(200).type("text/plain").send(
        "smithery-verification=f52238c37708d18a60b49b4f0d4d6f946b1d0d954e4f629e837bdb8bb726d591\n" +
        "smithery-verification=58fb\n",
      );
    });
  }

  app.get("/.well-known/mcp/server-card.json", (_req, res): void => {
    res.status(200).json(smitheryServerCard);
  });

  for (const path of [
    "/.well-known/mcp/connector.json",
    "/.well-known/glama-mcp-connector.json",
    "/.well-known/glama.json",
  ]) {
    app.get(path, (_req, res): void => {
      res.status(200).json(glamaConnector);
    });
  }
}