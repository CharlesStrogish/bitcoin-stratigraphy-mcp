import type { Express } from "express";

export const mcpServerCard = {
  name: "bitcoin-stratigraphy",
  description:
    "Bitcoin Stratigraphy data with Zero-Knowledge Data Integrity (Groth16/Poseidon zk-SNARKs), L402 multi-asset payments, and Nostr NIP-78 attestations. Paid payloads include zkProof data verifiable at POST /api/v1/zk/verify in sub-10ms for proofs emitted by this API.",
  transport: {
    type: "sse",
    url: "https://bitcoin-stratigraphy-dashboard--charlesstrogish.replit.app/mcp",
  },
  capabilities: {
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
        name: "get_stratigraphy",
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
            targetVerificationTime:
              "sub-10ms for proofs emitted by this API",
          },
        },
      },
      {
        name: "list_stratigraphy_catalog",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "verify_zk_proof",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "get_proof_status",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "list_proof_attestations",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: "submit_zk_proof",
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "get_mesh_status",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  },
} as const;

export const glamaConnector = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  claim: "glama_claim_4N7ubcwaG0adHJjd-Go2ue11blsBugXo",
} as const;

export function registerMcpServerCardRoute(app: Express): void {
  app.get("/.well-known/mcp/server-card.json", (_req, res): void => {
    res.status(200).json(mcpServerCard);
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