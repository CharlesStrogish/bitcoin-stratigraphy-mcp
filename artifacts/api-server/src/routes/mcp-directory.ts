// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import type { Express } from "express";
import { registryServerCard } from "./mcp-server-card";
import { clearingToolDefinitions } from "./clearing";

/**
 * A capacity catalog for directory indexers, not an executable tools/list.
 * Clearing stays host-enabled; discovery never mounts its controller.
 */
export const createMcpDirectoryManifest = (clearingEnabled = false) => ({
  ...registryServerCard,
  status: "ok",
  service: "MCP Server",
  toolCount: registryServerCard.toolCount + clearingToolDefinitions.length,
  enabledToolCount: registryServerCard.toolCount + (clearingEnabled ? clearingToolDefinitions.length : 0),
  catalogScope: "full-capacity",
  executionCatalog: "POST /mcp with tools/list",
  productionClearingSettlementEnabled: false,
  productionClearingPayoutsEnabled: false,
  capabilities: {
    ...registryServerCard.capabilities,
    toolCount: registryServerCard.toolCount + clearingToolDefinitions.length,
    enabledToolCount: registryServerCard.toolCount + (clearingEnabled ? clearingToolDefinitions.length : 0),
    tools: [
      ...registryServerCard.capabilities.tools.map((tool) => ({
        ...tool,
        enabled: true,
      })),
      ...clearingToolDefinitions.map((tool) => ({
        ...tool,
        enabled: clearingEnabled,
        availability: clearingEnabled
          ? "host-enabled extension; production settlement and payouts disabled"
          : "host-enabled extension; not mounted on this host",
      })),
    ],
  },
});

/** Mount after CORS, before body parsing, caller identity and payment gates. */
export function registerMcpDirectoryRoutes(app: Express, clearingEnabled = false): void {
  const manifest = createMcpDirectoryManifest(clearingEnabled);
  app.get("/health", (_req, res): void => {
    res.status(200).json({ status: "ok", service: "MCP Server" });
  });
  // Express also handles HEAD here. Never dispatch JSON-RPC from a GET body.
  app.get("/mcp", (_req, res): void => {
    res.status(200).json(manifest);
  });
}
