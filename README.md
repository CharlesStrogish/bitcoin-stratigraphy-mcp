# Bitcoin Stratigraphy MCP Server

[![Glama TDQS](https://img.shields.io/badge/Glama-Grade%20A%20%284.4%2F5.0%29-10b981)](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)
[![Smithery Rating](https://img.shields.io/badge/Smithery-100%2F100-brightgreen)](https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp)
[![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2025--11--25-orange)](https://modelcontextprotocol.io/specification/2025-11-25)
[![L402 Enabled](https://img.shields.io/badge/Monetization-L402%20Lightning-yellow)](https://l402.org)

Enterprise L402 data vending engine serving real-time thermodynamic Bitcoin telemetry, Groth16 ZK-SNARK verification, Nostr P2P mesh consensus, and agent context state grounding to autonomous AI swarms and LLM pipelines across **14 production tools**.

## Architecture Overview

```text
AI swarms & LLM agent clients
             |
             v
Discovery + Streamable HTTP MCP
/.well-known/mcp.json -> /mcp
             |
             v
L402 gateway + scoped macaroons
Pricing -> invoice -> payment proof
             |
             v
14-tool router / 4 namespaces
stratigraphy (5) | proof (6)
mesh (2)        | payment (1)
             |
             v
Telemetry / Groth16 / Nostr mesh
             |
             v
Lightning settlement / OTS receipts
```

- **Clients:** Claude, GPT-based agents, Perplexity integrations, autonomous
  swarms, and custom MCP runners need a compatible client; naming a client here
  does not imply that it has automatic wallet or payment support.
- **Discovery and gateway:** Public discovery identifies the MCP endpoint.
  `/api/v1/cost` advertises REST prices and asset availability;
  `payment.get_info` advertises MCP terms. Paid calls receive HTTP 402
  challenges, then redeem verified payment proofs and scoped macaroons.
- **Tool routing:** The canonical catalog contains 5 `stratigraphy.*`,
  6 `proof.*`, 2 `mesh.*`, and 1 `payment.*` tools.
- **Telemetry subsystem:** The 422-record historical dataset supports indexed
  lookups, numerical differences, source-record digests, and compact ranges.
  Historical height mappings are deterministic indices, not native block
  provenance. Live telemetry and the separate REST SSE feed have their own
  freshness and availability boundaries.
- **Cryptographic subsystem:** Groth16/Poseidon BN254 verifies defined telemetry
  statements; drift verification and OTS receipt verification have distinct
  evidence requirements. Signed agent-context receipts are a separate,
  off-chain Bitcoin-tip attestation mechanism.
- **Mesh and anchors:** NIP-01/78 broadcasts and pinned-peer quorum checks expose
  provenance and cross-validation metrics. Lightning settlement, signed tip
  receipts, and Bitcoin-confirmed OTS receipts are distinct mechanisms.

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
quality score, checked on September 30, 2026. The Smithery badge displays the
supplied **100/100** listing score. Follow the registry links for current results;
neither badge is an independent security audit or blanket verification of data.
Signed Bitcoin-tip receipts are attestations, not Groth16 proofs or Bitcoin
proof-of-work validity proofs.

## Tool Directory

The directory uses bulleted definitions rather than multi-column tables so each
tool description can wrap independently on mobile. These are the **14 canonical
MCP names** returned by `tools/list`.

### `stratigraphy.*` — 5 tools

- **`stratigraphy.list`** — Discover indexed date/height bounds, available metrics,
  and catalog metadata.
  - Access: free, parameterless discovery.
- **`stratigraphy.get`** — Retrieve full indexed telemetry records by date or
  height, recent days, or bounded ranges; optionally select metrics.
  - Access: paid, read-only. The record limit is 1–100, default 10.
- **`stratigraphy.get_digest`** — Retrieve compact source-record fingerprints
  and indexed metadata when full telemetry is unnecessary.
  - Access: paid, read-only. A fingerprint is not a verification receipt.
- **`stratigraphy.get_diff`** — Compute numerical deltas between two indexed
  entries, including height, target multiplier, percentage change, and elapsed days.
  - Access: paid, read-only. `fromTarget` is required; `toTarget` defaults to `latest`.
- **`stratigraphy.get_range`** — Retrieve compressed, contiguous summaries across
  inclusive indexed height or UTC date bounds.
  - Access: paid, read-only. `startTarget` is required; the batch limit is 1–100,
    default 50.

### `proof.*` — 6 tools

- **`proof.attenuate`** — Append restrictive caveats to an authentic, unexpired
  parent macaroon, including tool, target, path, expiration, and request budgets.
  - Access: free. Supply `macaroon` and `caveats`; `ttlSeconds` is optional.
    At least one restriction is required. A child cannot widen inherited authority,
    and later redemption still requires the parent's payment proof.
- **`proof.verify`** — Verify supplied Groth16 telemetry proofs, drift zk-SNARKs,
  or OpenTimestamps receipts.
  - Access: paid. Verification can update a bounded lifecycle index; drift checks
    require a Bitcoin block provider. OTS needs a real receipt and matching digest.
- **`proof.get_by_hash`** — Retrieve a retained proof, signed receipt, or
  lifecycle-only status using exactly one known `hash` or `jobId`.
  - Access: paid, read-only. Retrieval does not rerun Groth16 verification or
    reconstruct missing proof payloads.
- **`proof.list`** — Discover, filter, and paginate recent proof lifecycle
  summaries from bounded process-local memory.
  - Access: paid, currently 10 sats without valid credentials. Supports
    `limit`, `offset`, and optional `status`; returns summaries, not full proofs.
- **`proof.submit`** — Register a Groth16 proof with its five public signals,
  then attempt a NIP-78 attestation.
  - Access: paid; changes proof registry state. Nostr publication can fail
    separately, and registration does not append the proof to a Merkle tree.
- **`proof.ground`** — Issue a signed Bitcoin-tip receipt for agent context
  (`contextHash` plus `agentId`) or for a dataset CID.
  - Access: paid; the input modes are exclusive. This is an off-chain signed
    anchor, not a Groth16 proof, on-chain transaction, or Bitcoin-confirmed OTS receipt.

### `mesh.*` — 2 tools

- **`mesh.get_status`** — Inspect configured peer health, quorum status, node
  provenance, and cross-validation metrics.
  - Access: free, read-only. Status describes the configured pinned-peer mesh,
    not arbitrary-peer trust or proof of source truth.
- **`mesh.broadcast`** — Send signed indexed telemetry to configured peers
  through the outbound broadcast and cross-validation flow.
  - Access: paid; performs network side effects. Quorum results depend on the
    configured peer policy and availability.

### `payment.*` — 1 tool

- **`payment.get_info`** — Discover current MCP pricing and settlement methods,
  or check authenticated settlement status.
  - Access: `action: "query"` is free and is the default. `action: "settle"`
    requires authenticated payment evidence. Neither mode mints a macaroon or
    creates an invoice; paid tool calls issue HTTP 402 challenges.

Most paid MCP calls currently cost **250 sats** without valid credentials.
Check `payment.get_info` and the actual challenge for current terms; do not
assume a static per-call price applies to every payment policy or asset.

## Public Auto-Discovery

- **Manifest:** `GET /.well-known/mcp.json`
- **MCP transport:** Streamable HTTP at `/mcp`
- **Tool discovery:** JSON-RPC `tools/list`
- **REST cost discovery:** `GET /api/v1/cost`
- **MCP cost discovery:** `payment.get_info` with its default query action

The manifest is public and unmetered, returns `application/json`, and sets
`Access-Control-Allow-Origin: *`. After publishing the endpoint update, retrieve
it from the deployment:

```sh
curl -i https://bitcoin-stratigraphy-dashboard.replit.app/.well-known/mcp.json
```

The supplied manifest declares document version `2.0.0` and
`mcp.version: "2024-11-25"`. Those are metadata values, not protocol configuration.
The installed MCP SDK negotiates supported protocol versions, including
`2025-11-25`, which is the protocol shown in the badge and connection guidance.
Let clients negotiate rather than forcing the manifest's declared version.

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