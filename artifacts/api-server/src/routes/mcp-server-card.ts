import type { Express } from "express";

export const mcpServerCard = {
  name: "bitcoin-stratigraphy",
  transport: {
    type: "sse",
    url: "https://bitcoin-stratigraphy-dashboard--charlesstrogish.replit.app/mcp",
  },
  capabilities: {
    tools: [
      {
        name: "get_bitcoin_stratigraphy",
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