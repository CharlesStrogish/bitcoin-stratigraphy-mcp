#!/usr/bin/env node
// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Bitcoin Stratigraphy MCP Server
Transport: Streamable HTTP at /mcp (not stdio).
Usage: PORT=8008 bitcoin-stratigraphy-mcp-server
Requires DATABASE_URL, SESSION_SECRET, and NOSTR_PRIVATE_KEY; live Lightning requires NWC_URI.
Canonical stratigraphy tools require the licensed Python companion at 127.0.0.1:8000.
See README.md for companion setup and Sovereign Node RPC configuration.`);
} else {
  process.env.PORT ??= "8008";
  await import("./index.mjs");
}
