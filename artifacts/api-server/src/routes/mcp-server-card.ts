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

export function registerMcpServerCardRoute(app: Express): void {
  app.get("/.well-known/mcp/server-card.json", (_req, res): void => {
    res.status(200).json(mcpServerCard);
  });
}