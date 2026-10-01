# Bitcoin Stratigraphy Data Engine MCP

[![Glama Score: A (4.4/5.0)](https://img.shields.io/badge/Glama_Score-A_%284.4%2F5.0%29-brightgreen)](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)
[![Protocol: MCP (2025-11-25)](https://img.shields.io/badge/Protocol-MCP_%282025--11--25%29-blue)](https://modelcontextprotocol.io/specification/2025-11-25)
[![Protocol: L402 Lightning Micropayments](https://img.shields.io/badge/Protocol-L402_Lightning_Micropayments-orange)](CONNECT.md)
[![Zero-Knowledge: Groth16 ZK-SNARK Verified](https://img.shields.io/badge/Zero--Knowledge-Groth16_ZK--SNARK_Verified-blueviolet)](https://bitcoin-stratigraphy-dashboard.replit.app/.well-known/mcp/server-card.json)
[![Smithery: MCP Listing](https://img.shields.io/badge/Smithery-MCP_Listing-blue)](https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp)

Enterprise-grade L402 data vending engine serving real-time thermodynamic Bitcoin telemetry, cryptographic proof verification, and P2P mesh consensus to autonomous AI agents and LLM swarms.

## Key Capabilities

- L402 Micropayments & Macaroon Attenuations: Programmatic pay-per-query settlement in satoshis with zero API keys. Supports parent macaroon caveat scoping (proof.attenuate) with TTLs and rate controls.
- Multi-Asset Settlement Router: Native payment support across Base-layer Lightning (btc-lightning), Liquid Bitcoin (l-btc), Taproot Assets (taproot-assets), and Base USDC (x402).
- Groth16 ZK-SNARK & OTS Proof Verification: Execute cryptographic verification for supplied Groth16/Poseidon BN254 telemetry proofs, drift zk-SNARKs, and OpenTimestamps (OTS) Bitcoin block-header receipts.
- Agent Context State Grounding: Anchor autonomous agent prompt executions, CIDs, and dataset context hashes directly into signed Bitcoin-tip receipts (proof.ground).
- Autonomous P2P Mesh Network: Nostr-backed (NIP-01/78) peer topology broadcasting with automated quorum validation, cross-validation metrics, and node public-key provenance.
- Stratigraphy Strata Analytics: High-speed differential comparisons (stratigraphy.get_diff) and compressed record digests designed specifically for LLM context window efficiency.
- Real-Time SSE Streaming: Live Server-Sent Events (/api/v1/stratigraphy/stream) for continuous telemetry feeds.

### Operational boundaries

- **Payment rails are surface- and configuration-dependent.** The REST L402 router
  supports `btc-lightning`, `l-btc`, and `taproot-assets`; Liquid and Taproot Assets
  need configured providers. Check `/api/v1/cost` for availability. MCP paid tools
  use Lightning L402 plus Base USDC x402 only when configured; `payment.get_info`
  reports their current terms, not all REST router assets. Lightning is Bitcoin's
  payment-channel layer; Base USDC is a separate EVM rail.
- **API-keyless does not mean unauthenticated paid execution.** Wallet
  authorization, exact payment proofs, scoped credentials, and client spending
  limits remain required. Macaroon TTL/request budgets and HTTP rate limits are
  separate controls.
- **Live streaming and historical indexing are different.** MCP uses Streamable
  HTTP at `/mcp`. The paid REST SSE feed at `/api/v1/stratigraphy/stream` refreshes
  snapshots on a 30-second cadence and supports configured L402 router assets,
  not a promised Base USDC SSE rail. Historical strata remain indexed daily
  records, not native block provenance.
- **Cryptographic checks have defined trust boundaries.** Groth16 verifies an
  exact statement/payload, not source truth or every agent reasoning step.
  Grounding receipts are off-chain Schnorr-signed Bitcoin-tip attestations, not
  on-chain transactions or ZK/PoW validity proofs. OTS verification requires an
  actual receipt and matching target digest; calendar acceptance is not Bitcoin
  confirmation.
- **Mesh consensus is scoped.** Broadcasts and quorum checks use configured,
  pinned peers; peer agreement does not establish source truth. Enterprise use
  still requires organizational supervision and durable evidence retention; see
  [the compliance framework](docs/ENTERPRISE_COMPLIANCE.md).

The Glama badge is a static snapshot of the **A (4.4/5.0)** tool-definition
quality score, checked on September 30, 2026; follow its link for current results.
The zero-knowledge badge describes the supported Groth16 proof circuits, not an
independent security audit or blanket verification of all data. Signed Bitcoin-tip
receipts are attestations, not Groth16 proofs or Bitcoin proof-of-work validity proofs.

## Quick Connect

**Live MCP endpoint:** `https://bitcoin-stratigraphy-dashboard.replit.app/mcp`

**Transport:** Streamable HTTP · **Protocol:** MCP `2025-11-25`

Discovery with `stratigraphy.list` and `payment.get_info` is free. These connection
examples do **not** provide a wallet or pay L402 invoices automatically. Check
`payment.get_info` for current per-tool prices before enabling paid calls; the
published price for most paid tools is 250 sats, not 10 sats.

### Claude Desktop

Open **Settings → Developer → Edit Config**, then merge this entry into
`claude_desktop_config.json` (requires Node.js and `npx`). The `mcp-remote`
bridge connects Claude Desktop's local stdio client to the remote HTTP server:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"]
    }
  }
}
```

Restart Claude Desktop, then confirm `bitcoin-stratigraphy` appears in its MCP
server list. Start with `stratigraphy.list` or `payment.get_info`.

See [CONNECT.md — Claude Desktop](CONNECT.md#claude-desktop) for setup and payment details.

### Cursor

Add to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "url": "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
    }
  }
}
```

Merge the entry into any existing `mcpServers` object, then enable the server in
Cursor's MCP settings. Cursor connects directly over HTTP; no local server is needed.

See [CONNECT.md — Cursor](CONNECT.md#cursor) for setup and payment details.

### Custom Agent Orchestrators

Use the official TypeScript MCP SDK's `StreamableHTTPClientTransport`. Install
the SDK in your agent project:

```sh
npm install @modelcontextprotocol/sdk
```

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({
  name: "stratigraphy-agent",
  version: "1.0.0",
});

try {
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL("https://bitcoin-stratigraphy-dashboard.replit.app/mcp"),
    ),
  );

  const catalog = await client.listTools();
  console.log(catalog.tools.map((tool) => tool.name));

  // Free pricing discovery only; this does not authorize a payment.
  const paymentInfo = await client.callTool({
    name: "payment.get_info",
    arguments: {},
  });
  console.log(paymentInfo);
} finally {
  await client.close();
}
```

For other languages or frameworks, use an MCP client supporting Streamable HTTP
and initialize it against the same URL. Let the client negotiate the protocol
version and manage MCP headers; this is not a legacy `/sse` endpoint.

Paid tool execution requires a separate, wallet-enabled L402 integration:
handle the HTTP `402` challenge, obtain explicit payment authorization, pay the
Lightning invoice, and retry using `Authorization: L402 <macaroon>:<preimage>`.
Never commit wallet secrets, macaroons, or payment preimages to client
configuration or registry files. See [CONNECT.md](CONNECT.md) for payment details.

### ElizaOS

Install `@elizaos/plugin-mcp` and make `npx` available to the agent:

```ts
import type { Character } from "@elizaos/core";

export const character: Character = {
  name: "StratigraphyAgent",
  plugins: ["@elizaos/plugin-mcp"],
  settings: {
    mcp: {
      servers: {
        bitcoinStratigraphy: {
          type: "stdio",
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
          ],
        },
      },
    },
  },
  system: "Inspect payment.get_info before requesting paid Bitcoin Stratigraphy tools.",
};
```

See [CONNECT.md — ElizaOS character](CONNECT.md#elizaos-character) for setup and payment details.

## Ecosystem Registry Discovery

- [Smithery listing](https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp)
  · root connection metadata: [`smithery.yaml`](smithery.yaml).
- [Glama listing and live score](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)
  · root metadata: [`glama.json`](glama.json).
- [Public MCP server card](https://bitcoin-stratigraphy-dashboard.replit.app/.well-known/mcp/server-card.json)
  · [Agent discovery guide](https://bitcoin-stratigraphy-dashboard.replit.app/llms.txt).

Root metadata makes the repository easier to inspect, but does not automatically
submit it to every index. For Smithery's current remote-server registration flow,
submit the live MCP URL at [smithery.ai/new](https://smithery.ai/new), or use its CLI
from an authenticated maintainer account:

```sh
smithery mcp publish "https://bitcoin-stratigraphy-dashboard.replit.app/mcp" -n crstrogish/bitcoin-stratigraphy-mcp
```

See [Smithery's publishing documentation](https://smithery.ai/docs/build/publish).
This connects a registry listing to the existing server; it does not deploy a
local stdio process or require changes to the server's tool definitions.