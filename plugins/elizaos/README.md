# ElizaOS plugin for Bitcoin Stratigraphy

This plugin wraps the existing TypeScript MCP client. It adds three ElizaOS
actions: `FETCH_BITCOIN_STRATIGRAPHY` (formerly `GET_BITCOIN_STRATIGRAPHY_TELEMETRY`),
`VERIFY_BITCOIN_STRATIGRAPHY_PROOF`, and
`BROADCAST_BITCOIN_STRATIGRAPHY_MESH`. It targets `@elizaos/core` 1.x.

These actions are a deliberately narrow MCP integration, not an adapter for
every engine feature or payment rail. Paid calls use the configured Lightning
L402 wallet callback; the REST router's `btc-lightning`, `l-btc`, and
`taproot-assets` options and conditional MCP Base USDC x402 are not wired by
this plugin. The MCP server's `proof.verify` also supports supplied drift
proofs and OTS receipts, but this plugin action's documented structured input
is for Groth16 telemetry proofs. Mesh broadcasts require configured trusted
peers and a peer receipt; quorum is cross-validation, not source truth.

## Register in `elizaConfig.ts`

In a project that uses ElizaOS `Project`/`ProjectAgent` configuration:

```ts
import type { Project } from "@elizaos/core";
import { bitcoinStratigraphyPlugin } from "@bitcoin-stratigraphy/plugin-elizaos";
import { lightningWalletPlugin } from "./your-lightning-wallet-plugin.js";

export const elizaConfig = {
  agents: [{
    character: { name: "Bitcoin Researcher", bio: "Analyzes Bitcoin telemetry." },
    plugins: [lightningWalletPlugin, bitcoinStratigraphyPlugin],
  }],
} satisfies Project;
```

Register a wallet plugin that exposes a runtime service named
`bitcoin-stratigraphy-wallet`. Its service must implement
`payInvoice(invoice: string): Promise<string | { preimage: string } | { payment_preimage: string }>`.
Set `NWC_PAIRING_SECRET` in the agent runtime settings to its payer wallet's
`nostr+walletconnect://` pairing URI; both this setting and the wallet service
are required for paid actions. The wallet service must enforce its own spending
limits and approval policy. A Nostr signing keypair by itself cannot pay.
External Lightning payments require a 32-byte hex preimage. CoinOS internal
payments may instead return a canonical UUID payment ID, which the API verifies
against the issuer's incoming and payer's outgoing records.

The handlers find the service using
`runtime.getService("bitcoin-stratigraphy-wallet")`. If it is absent, action
validation returns false and direct handler calls report an error without
requesting payment. The SDK verifies standard preimages against the L402
challenge, retries the original request once, and never caches single-use
credentials. The `bitcoinStratigraphyProvider` reads the last successful
telemetry result from agent-scoped runtime cache to provide a date, day, queried
block height (if known), and metrics. It never makes a paid request on a prompt
and never presents a historical record as the current chain tip.

The MCP endpoint defaults to
`https://bitcoinstratigraphy.com/mcp`. Set
`BITCOIN_STRATIGRAPHY_MCP_URL` in the agent runtime settings to use a different
full `/mcp` URL.

## Pass action input

Telemetry accepts structured arguments in `message.content.input` or action
`options.input` using MCP names such as `{ days: 7, metrics:
["target_multiplier"] }`, `{ date: "2026-09-09" }`, or
`{ startDate: "2026-09-01", endDate: "2026-09-09", limit: 10 }`. A conversational
request mentioning a `YYYY-MM-DD` date or “last 7 days” also works. An
unqualified request fetches the latest day.

Proof verification **requires structured input**:

```ts
message.content.input = {
  proof: encodedProof,
  publicInputs: { blockHeight, snapshotDigest, thermodynamicHash, timestamp, valuationSat },
  verificationKeyId,
  data: originalSnapshot,
};
```

Mesh broadcast takes `{ date: "2026-09-09" }` or a date in the request text.
It broadcasts an existing dataset snapshot, not arbitrary agent-supplied data,
and only succeeds when the server has configured trusted peers. These actions
are paid (250 sats each). An invalid proof is reported as an invalid result,
not as a successful verification claim.

From this repository, run `pnpm --filter @bitcoin-stratigraphy/plugin-elizaos
build`, `pnpm --filter @bitcoin-stratigraphy/plugin-elizaos typecheck`, or
`pnpm --filter @bitcoin-stratigraphy/plugin-elizaos test`. After building, a
local agent project can link this directory with `pnpm link /absolute/path/to/plugins/elizaos`;
that agent project must also install its own compatible `@elizaos/core` peer.
The package exports its bundled ESM entry point and declaration files, and
rebuilds them automatically before `pnpm pack` or publication.