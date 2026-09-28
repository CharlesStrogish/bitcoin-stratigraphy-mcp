# Connect an agent to Bitcoin Stratigraphy

The public MCP endpoint is **`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`** (Streamable HTTP). It exposes discovery and tool calls over JSON-RPC. The examples below configure the same server; they do **not** give an agent a wallet or permission to spend. Set a spending limit and use an L402-capable wallet client before enabling paid calls.

## MCP clients

### Claude Desktop

Add this entry to Claude Desktop's `mcpServers` configuration and restart the app. This uses the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) stdio bridge, so Node.js/npm must be available on the machine running Claude Desktop.

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

### Cursor

Add this to the project `.cursor/mcp.json` or your personal `~/.cursor/mcp.json`, then restart Cursor. Cursor supports a remote MCP URL directly.

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "url": "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
    }
  }
}
```

### Goose

If you maintain a **portable `mcpServers` JSON** alongside other clients, the equivalent entry is:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "url": "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
    }
  }
}
```

**Goose does not read that JSON as its native configuration.** Add a remote Streamable HTTP extension in Goose's UI, run `goose session --with-streamable-http-extension "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"`, or put this in `~/.config/goose/config.yaml`:

```yaml
extensions:
  bitcoin-stratigraphy:
    name: Bitcoin Stratigraphy
    type: streamable_http
    uri: https://bitcoin-stratigraphy-dashboard.replit.app/mcp
    enabled: true
    timeout: 300
```

### ElizaOS character

Install `@elizaos/plugin-mcp` and run the agent where `npx` is available. The stdio bridge connects the plugin to this remote `/mcp` endpoint; this is not the separate Bitcoin Stratigraphy ElizaOS actions plugin.

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
  system: "Inspect payment.info before requesting paid Bitcoin Stratigraphy tools.",
};
```

The MCP client configurations above discover tools, but **do not automatically settle Lightning invoices**. For autonomous paid calls, integrate a wallet in the agent runtime and handle L402 as shown below. Never put wallet credentials or payment preimages in character files or checked-in client configuration.

## Tool catalog and pricing

The published `tools/list` response contains **14 tools**. The prices below are the advertised sats from the published server's `payment.info` response at the time this document was prepared; ask `payment.info` again at runtime rather than treating this table as a price guarantee.

| Tool | Advertised sats | Use |
| --- | ---: | --- |
| `stratigraphy.get` | 250 | Full indexed daily telemetry (date, indexed height, or bounded selection); not a block-hash lookup. |
| `stratigraphy.digest` | 250 | Token-optimized telemetry summary. |
| `stratigraphy.diff` | 250 | Differences between indexed strata. |
| `stratigraphy.range` | 250 | Compressed records across a bounded sequence. |
| `stratigraphy.list` | 10 | Discover dataset bounds and metrics. |
| `proof.attenuate` | 0 | Narrow an existing valid macaroon; does not pay an invoice. |
| `proof.verify` | 250 | Validate an existing Groth16 proof without registering it; not an OTS-record verifier. |
| `proof.get_by_hash` | 250 | Look up a retained proof or signed receipt. |
| `proof.list` | 10 | List indexed proof attestations. |
| `proof.submit` | 250 | Register a submitted proof and attempt an attestation; changes state. |
| `proof.ground` | 250 | Issue a signed Bitcoin-tip context/dataset receipt. |
| `payment.info` | 0 | Inspect advertised prices and L402 rules; no invoice is issued. |
| `mesh.get_status` | 0 | Read peer and quorum health. |
| `mesh.broadcast` | 250 | Sign and distribute a stored snapshot to mesh peers; has side effects. |

Call `payment.info` with `{}` for the complete `perToolSats` map, or `{"toolName":"stratigraphy.digest"}` to narrow it to one **case-sensitive, canonical** tool name. Unknown names fail validation. Its result includes `acceptedPaymentMethods: ["Lightning L402"]`, `invoiceExpirySeconds`, and challenge metadata. It is a free preflight request, **not** a payment, invoice, or macaroon restriction. The actual invoice is issued only when a paid `tools/call` receives HTTP **402**. Do not substitute `proof.attenuate` for pricing discovery.

For direct HTTP clients, a preflight request looks like:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-03-26

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"payment.info","arguments":{"toolName":"stratigraphy.digest"}}}
```

Read the price from `result.structuredContent.perToolSats["stratigraphy.digest"]`. Some clients also expose the same JSON in the MCP text content.

## TypeScript: handle an L402 challenge

The server responds to an unauthenticated paid call with HTTP 402, `WWW-Authenticate: L402 macaroon="...", invoice="..."`, and JSON containing `macaroon`, `invoice`, `payment_hash`, and `amount_sats`. Pay **that exact invoice**, verify that the wallet's 32-byte preimage hashes to `payment_hash`, then retry the **same** JSON-RPC call once with `Authorization: L402 <macaroon>:<preimage>`. The credential is scoped to a paid call and must not be cached or reused. The wallet callback below must be connected to a real wallet with its own authorization and spending policy; it is deliberately not a hard-coded credential.

```ts
const endpoint = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp";

type Rpc<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
};
type ToolResult = { structuredContent?: unknown; content?: unknown[] };
type PriceInfo = { structuredContent: { perToolSats: Record<string, number> } };
type Challenge = {
  macaroon: string;
  invoice: string;
  payment_hash: string;
  amount_sats: number;
};

async function send(id: number, name: string, args: object, authorization?: string) {
  return fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function readResult<T>(response: Response, id: number): Promise<T> {
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  const rpc = (await response.json()) as Rpc<T>;
  if (rpc.jsonrpc !== "2.0" || rpc.id !== id) throw new Error("Invalid MCP response");
  if (rpc.error) throw new Error(`MCP ${rpc.error.code}: ${rpc.error.message}`);
  if (rpc.result === undefined) throw new Error("Missing MCP result");
  return rpc.result;
}

export async function invokeWithL402(
  toolName: string,
  args: object,
  payInvoice: (invoice: string) => Promise<string>, // wallet returns 32-byte hex preimage
  maxSats: number,
): Promise<ToolResult> {
  const prices = await readResult<PriceInfo>(
    await send(1, "payment.info", { toolName }),
    1,
  );
  const advertised = prices.structuredContent.perToolSats[toolName];
  if (!Number.isInteger(advertised) || advertised < 0)
    throw new Error("Tool has no advertised price");
  if (advertised > maxSats) throw new Error("Advertised price exceeds spending limit");

  const id = 2;
  let response = await send(id, toolName, args);
  if (response.status === 402) {
    if (advertised === 0) throw new Error("Unexpected payment demand for a free tool");
    const header = response.headers.get("WWW-Authenticate") ?? "";
    const match = /^L402\s+macaroon="([^"\r\n]+)",\s*invoice="([^"\r\n]+)"$/i.exec(header);
    const challenge = (await response.json()) as Partial<Challenge>;
    const paymentHash = challenge.payment_hash;
    if (!match || challenge.macaroon !== match[1] ||
        challenge.invoice !== match[2] || !challenge.invoice.startsWith("ln") ||
        typeof paymentHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(paymentHash) ||
        !Number.isInteger(challenge.amount_sats) ||
        (challenge.amount_sats ?? 0) <= 0 ||
        (challenge.amount_sats ?? Infinity) > maxSats) {
      throw new Error("Invalid or over-budget L402 challenge");
    }

    const preimage = await payInvoice(challenge.invoice);
    if (!/^[0-9a-fA-F]{64}$/.test(preimage))
      throw new Error("Wallet did not return a 32-byte hex preimage");
    const bytes = Uint8Array.from(preimage.match(/.{2}/g)!, (hex) => parseInt(hex, 16));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("");
    if (hash !== paymentHash.toLowerCase())
      throw new Error("Wallet preimage does not match the invoice payment hash");

    response = await send(id, toolName, args,
      `L402 ${challenge.macaroon}:${preimage.toLowerCase()}`);
    if (response.status === 402) throw new Error("Payment rejected; do not pay again");
  }
  return readResult<ToolResult>(response, id);
}

// Supply a real wallet adapter (for example, a wallet-connect client) here:
// const result = await invokeWithL402(
//   "stratigraphy.digest", { target: "latest" },
//   (invoice) => wallet.payInvoice(invoice), 250,
// );
```

For concurrent agents, deduplicate payment for the *same* in-flight challenge and do not let an older 402 response overwrite newer credentials. Never submit a preimage until it has been checked against the selected challenge's payment hash. A CoinOS internal-payment reference has separate server-side verification and is **not** a 32-byte preimage; the sample above intentionally handles ordinary Lightning preimages only. See `sdk/typescript/client.ts` for the project's existing MCP payment client.

## Configuration references

- [Cursor MCP integrations](https://cursor.com/help/customization/mcp)
- [Goose extensions and native configuration](https://block.github.io/goose/docs/getting-started/using-extensions)
- [ElizaOS MCP plugin character configuration](https://docs.elizaos.ai/runtime/services)
- [`mcp-remote` stdio bridge](https://www.npmjs.com/package/mcp-remote)