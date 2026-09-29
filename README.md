# Bitcoin Stratigraphy Data Engine MCP

[![bitcoin-stratigraphy MCP connector – tool definition quality and endpoint health on Glama](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy/badges/score.svg)](https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy)

[![smithery badge](https://smithery.ai/badge/crstrogish/bitcoin-stratigraphy-mcp)](https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp)

## Agent Quickstart

Public MCP endpoint: `https://bitcoin-stratigraphy-dashboard.replit.app/mcp` (Streamable HTTP).
Discovery with `stratigraphy.list` and `payment.get_info` is free. These connection
examples do **not** provide a wallet or pay L402 invoices automatically. Check
`payment.get_info` for current per-tool prices before enabling paid calls; the
published price for most paid tools is 250 sats, not 10 sats.

### Claude Desktop

Add to `claude_desktop_config.json` (requires Node.js and `npx`):

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

See [CONNECT.md — Cursor](CONNECT.md#cursor) for setup and payment details.

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