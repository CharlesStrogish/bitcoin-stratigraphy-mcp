import type { Express } from "express";

export const mcpServerCard = {
  name: "bitcoin-stratigraphy",
  description:
    "Bitcoin Stratigraphy data with Zero-Knowledge Data Integrity (Groth16/Poseidon zk-SNARKs), L402 multi-asset payments, and Nostr NIP-78 attestations. Paid payloads include zkProof data verifiable at POST /api/v1/zk/verify in sub-10ms for proofs emitted by this API.",
  transport: {
    type: "sse",
    url: "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
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
            targetVerificationTime:
              "sub-10ms for proofs emitted by this API",
          },
        },
      },
      {
        name: "stratigraphy.digest",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          l402: { amountSats: 250 },
        },
      },
      {
        name: "stratigraphy.diff",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          l402: { amountSats: 250 },
        },
      },
      {
        name: "stratigraphy.range",
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
          openWorldHint: false,
        },
      },
      {
        name: "proof.get_status",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
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
          verificationEndpoint: "POST /api/v1/zk/verify",
        },
      },
      {
        name: "proof.issue_receipt",
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
        },
      },
      {
        name: "payment.info",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
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

export const glamaConnector = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  claim: "glama_claim_4N7ubcwaG0adHJjd-Go2ue11blsBugXo",
} as const;

export function registerMcpServerCardRoute(app: Express): void {
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