# ElizaOS plugin for Bitcoin Stratigraphy

This plugin wraps the existing TypeScript MCP client. It adds three ElizaOS
actions: `GET_BITCOIN_STRATIGRAPHY_TELEMETRY`,
`VERIFY_BITCOIN_STRATIGRAPHY_PROOF`, and
`BROADCAST_BITCOIN_STRATIGRAPHY_MESH`. It targets `@elizaos/core` 1.x.

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
The returned value **must contain the actual 32-byte hex Lightning preimage**.
The agent wallet may use NWC, LNURL, or a Lightning wallet behind this service;
apply spending limits and approval policy in that wallet plugin. A Nostr
signing keypair by itself cannot pay an invoice. Do not return a transaction ID,
payment hash, or a wallet self-payment UUID instead of a preimage.

The handlers find the service using
`runtime.getService("bitcoin-stratigraphy-wallet")`. If it is absent, action
validation returns false and direct handler calls report an error without
requesting payment. The SDK verifies the preimage against the L402 challenge,
retries the original request once, and never caches single-use credentials.

The MCP endpoint defaults to
`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`. Set
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
`pnpm --filter @bitcoin-stratigraphy/plugin-elizaos test`.