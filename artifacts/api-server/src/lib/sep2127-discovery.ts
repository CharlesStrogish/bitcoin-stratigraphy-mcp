// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { CANONICAL_ORIGIN, canonicalUrl } from "./public-site";
import {
  MCP_SERVER_INFO,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "./mcp-stateless";

export const SEP2127_PATHS = [
  "/.well-known/ai-catalog.json",
  "/mcp/server-card",
  "/server-card",
] as const;
export const MCP_SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

export function isSep2127DiscoveryPath(path: string): boolean {
  const normalized = path.toLowerCase().replace(/\/$/, "");
  return SEP2127_PATHS.some((candidate) => candidate === normalized);
}

/** Static public connectivity only; tool/resource discovery remains on MCP. */
export function buildSep2127Discovery() {
  const domain = new URL(CANONICAL_ORIGIN).hostname;
  return {
    serverCard: {
      $schema:
        "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: "com.bitcoinstratigraphy/mcp",
      title: "Bitcoin Stratigraphy MCP Server",
      version: MCP_SERVER_INFO.version,
      description:
        "Bitcoin L402 telemetry, OpenTimestamps notarization, and tamper-evident AI audit MCP server.",
      websiteUrl: CANONICAL_ORIGIN,
      remotes: [
        {
          type: "streamable-http",
          url: canonicalUrl("/mcp"),
          supportedProtocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        },
      ],
    },
    catalog: {
      specVersion: "1.0",
      host: {
        displayName: "Bitcoin Stratigraphy",
        identifier: `did:web:${domain}`,
      },
      entries: [
        {
          identifier: `urn:air:${domain}:mcp:bitcoin-stratigraphy`,
          type: MCP_SERVER_CARD_MEDIA_TYPE,
          url: canonicalUrl("/mcp/server-card"),
        },
      ],
    },
  };
}
