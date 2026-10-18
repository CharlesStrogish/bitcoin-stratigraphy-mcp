# Connect an agent to Bitcoin Stratigraphy

The public MCP endpoint is **`https://bitcoinstratigraphy.com/mcp`** (Streamable HTTP). It exposes discovery and tool calls over JSON-RPC. The examples below configure the same server; they do **not** give an agent a wallet or permission to spend. Set a spending limit and use an L402-capable wallet client before enabling paid calls.

## Capability and service boundaries

Bitcoin Stratigraphy provides indexed stratigraphy analytics and compressed
digests/diffs for efficient agent context; `proof.attenuate` can narrow an
existing valid macaroon with caveats including expiration boundaries, exact
tool targets, and request-count limits.
The MCP proof workflow includes Groth16/Poseidon BN254 telemetry and drift
verification, plus a separate OpenTimestamps (OTS) receipt-verification mode.
`proof.ground` issues off-chain Schnorr-signed Bitcoin-tip receipts for context
or dataset CIDs; it does not publish a Bitcoin transaction or prove native
block provenance for the historical dataset.

The pinned Nostr NIP-01/78 mesh supports reciprocal peer exchange, signed
broadcasts, and quorum checks. Peer agreement is an availability/consistency
signal, not source truth or independent proof of the underlying telemetry.

The REST API is separate from MCP. `GET /api/v1/cost` reports current prices
and available settlement assets, including the L402 router's `btc-lightning`,
`l-btc`, and `taproot-assets` where enabled. MCP accepts Lightning L402; Base
USDC x402 is conditional and must be explicitly shown as available. Do not
assume Base USDC is available on REST. The paid REST endpoint
`GET /api/v1/stratigraphy/stream` is a separate Server-Sent Events (SSE)
transport with a 30-second refresh interval, not an MCP transport. It uses
L402 assets as reported by `/api/v1/cost`; Base USDC support is not promised
for this stream.

## MCP clients

### Claude Desktop

Add this entry to Claude Desktop's `mcpServers` configuration and restart the app. This uses the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) stdio bridge, so Node.js/npm must be available on the machine running Claude Desktop.

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://bitcoinstratigraphy.com/mcp"]
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
      "url": "https://bitcoinstratigraphy.com/mcp"
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
      "url": "https://bitcoinstratigraphy.com/mcp"
    }
  }
}
```

**Goose does not read that JSON as its native configuration.** Add a remote Streamable HTTP extension in Goose's UI, run `goose session --with-streamable-http-extension "https://bitcoinstratigraphy.com/mcp"`, or put this in `~/.config/goose/config.yaml`:

```yaml
extensions:
  bitcoin-stratigraphy:
    name: Bitcoin Stratigraphy
    type: streamable_http
    uri: https://bitcoinstratigraphy.com/mcp
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
            "https://bitcoinstratigraphy.com/mcp",
          ],
        },
      },
    },
  },
  system: "Inspect payment.get_info before requesting paid Bitcoin Stratigraphy tools.",
};
```

The MCP client configurations above discover tools, but **do not automatically settle Lightning invoices**. For autonomous paid calls, integrate a wallet in the agent runtime and handle L402 as shown below. Never put wallet credentials or payment preimages in character files or checked-in client configuration.

## Tool catalog and pricing

The MCP `tools/list` response currently contains **16 canonical tools**; only `stratigraphy.list` and `proof.list` are free. The prices below describe the server code; confirm them at runtime with the free `POST /api/v1/cost` quote (for example `{"tools":["stratigraphy.get_digest"]}`) or the paid `payment.get_info` tool rather than treating this table as a price guarantee.

| Tool | Advertised sats | Use |
| --- | ---: | --- |
| `stratigraphy.get` | 250 | Full indexed daily telemetry (date, indexed height, or bounded selection); not a block-hash lookup. |
| `stratigraphy.get_digest` | 250 | Token-optimized telemetry summary. |
| `stratigraphy.get_diff` | 250 | Differences between indexed strata. |
| `stratigraphy.get_range` | 250 | Compressed records across a bounded sequence. |
| `stratigraphy.list` | 0 | Discover dataset bounds and metrics. |
| `proof.attenuate` | 250 | Narrow an existing valid macaroon; requires its own L402 authorization and does not pay the parent invoice. |
| `proof.verify` | 250 | Validate an existing Groth16 proof (default), or set `proofType: "ots"` with `otsProof` and `targetHash` to verify a complete OTS receipt and its Bitcoin attestation. |
| `proof.get_by_hash` | 250 | Look up a retained proof or signed receipt. |
| `proof.list` | 0 | List indexed proof attestations. |
| `proof.submit` | 250 | Register a submitted proof and attempt an attestation; changes state. |
| `proof.notarize` | 250 | Create a detached OpenTimestamps receipt for a SHA-256 digest; calendar acceptance is not Bitcoin confirmation. |
| `proof.ground` | 250 | Issue a signed Bitcoin-tip context/dataset receipt. |
| `payment.get_info` | 250 | Query prices (default) or set `action: "settle"` to verify a server-issued L402 credential or settle an authenticated x402 signature. Bare preimages and hashes are not enough; settlement claims are not bearer tokens. |
| `mesh.get_status` | 250 | Read peer and quorum health. |
| `mesh.broadcast` | 250 | Sign and distribute a stored snapshot to mesh peers; has side effects. |

Call `payment.get_info` with `{}` (equivalent to `{"action":"query"}`) for the complete `perToolSats` map, or `{"toolName":"stratigraphy.get_digest"}` to narrow it to one **case-sensitive, canonical** tool name. Unknown names fail validation. The query result includes accepted methods, invoice expiry, and challenge metadata. It does not issue an invoice; the actual invoice is issued only when a paid `tools/call` receives HTTP **402**. Use `{"action":"settle","paymentHash":"…","preimage":"…"}` with matching L402 Authorization, or, only when MCP Base USDC x402 is currently enabled, `{"action":"settle","paymentHash":"0x…","txHash":"0x…"}` with PAYMENT-SIGNATURE. Settlement does not authorize access to another tool.

For direct HTTP clients, a preflight request looks like:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: payment.get_info

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"payment.get_info","arguments":{"toolName":"stratigraphy.get_digest"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
```

The endpoint implements the stateless MCP `2026-07-28` transport. There is no
`initialize` handshake and no `Mcp-Session-Id`, so any server instance can
answer any request. Call `server/discover` (with the same `_meta`,
`MCP-Protocol-Version` and `Mcp-Method: server/discover`) to read supported
versions and capabilities. Every request repeats its protocol version and client
capabilities in `params._meta`. The `MCP-Protocol-Version`, `Mcp-Method` and,
for `tools/call`, `Mcp-Name` headers must equal the body values; otherwise the
request fails with JSON-RPC error `-32020`. An unsupported version returns
`-32022` with the supported list. Handshake-era clients that send
`MCP-Protocol-Version: 2025-11-25` without `_meta` can still `initialize` and
call tools as before.

Read the price from `result.structuredContent.perToolSats["stratigraphy.get_digest"]`. Some clients also expose the same JSON in the MCP text content.

## TypeScript: handle an L402 challenge

The server responds to an unauthenticated paid call with HTTP 402, `WWW-Authenticate: L402 macaroon="...", invoice="..."`, and a JSON-RPC error (code `402`) whose `error.data` contains `macaroon`, `invoice`, `payment_hash`, and `amount_sats`. Handshake-era `2025-11-25` clients receive the same fields at the top level of the response body. Pay **that exact invoice**, verify that the wallet's 32-byte preimage hashes to `payment_hash`, then retry the **same** JSON-RPC call once with `Authorization: L402 <macaroon>:<preimage>`. MCP paid-call credentials are tool/request-scoped; do not reuse one to authorize another tool or REST scope. This differs from any REST subscription credential, whose reuse is governed by its own path, request, and expiry caveats. The wallet callback below must be connected to a real wallet with its own authorization and spending policy; it is deliberately not a hard-coded credential.

```ts
const endpoint = "https://bitcoinstratigraphy.com/mcp";

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

const PROTOCOL = "2026-07-28";

async function send(id: number, name: string, args: object, authorization?: string) {
  return fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
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
    await send(1, "payment.get_info", { toolName }),
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
    const rpc = (await response.json()) as { error?: { data?: Partial<Challenge> } };
    const challenge = rpc.error?.data ?? {};
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
//   "stratigraphy.get_digest", { target: "latest" },
//   (invoice) => wallet.payInvoice(invoice), 250,
// );
```

For concurrent agents, deduplicate payment for the *same* in-flight challenge and do not let an older 402 response overwrite newer credentials. Never submit a preimage until it has been checked against the selected challenge's payment hash. A CoinOS internal-payment reference has separate server-side verification and is **not** a 32-byte preimage; the sample above intentionally handles ordinary Lightning preimages only. See `sdk/typescript/client.ts` for the project's existing MCP payment client.

## Zero-polling execution with `webhook_url`

`stratigraphy.get_range` and `proof.submit` accept an optional `webhook_url`
argument. Add it to the paid call; the rest of the L402 flow is unchanged.

1. **Unpaid call.** The callback is checked before anything else: it must be an
   absolute `https://` URL without credentials, and its host must resolve only
   to public addresses. Loopback, private, link-local, cloud-metadata and other
   reserved targets fail with JSON-RPC `-32602` before an invoice is issued.
   When the server's task queue is full, the call fails with HTTP 503 and
   `Retry-After`; retry later or omit `webhook_url`. Otherwise you receive the
   usual 402 challenge.
2. **Paid retry.** The server verifies payment and answers **HTTP 202
   Accepted** without waiting for the tool:

   ```json
   {"jsonrpc":"2.0","id":7,"result":{"task_id":"5d0c6f1e-6a43-4c8e-9f0b-2f1d4c7b9a10","status":"pending","tool":"stratigraphy.get_range","created_at":"2026-10-18T14:03:11.204Z"}}
   ```

3. **Callback.** When the tool finishes, the server sends one `POST` to the
   callback with `Content-Type: application/json`, an `X-MCP-Task-Id` header
   and Standard Webhooks signature headers (see below):

   ```json
   {"task_id":"5d0c6f1e-6a43-4c8e-9f0b-2f1d4c7b9a10","status":"completed","tool":"stratigraphy.get_range","request_id":7,"created_at":"2026-10-18T14:03:11.204Z","completed_at":"2026-10-18T14:03:12.877Z","result":{"content":[{"type":"text","text":"…"}],"structuredContent":{"…":"…"}}}
   ```

   `result` is exactly the MCP result a synchronous call returns; for
   `2026-07-28` requests it also carries `resultType: "complete"` and the
   server `_meta`. Results with `isError: true` still have status `completed`.
   A JSON-RPC failure after payment, such as a range with no captured records,
   arrives with `"status":"failed"` and an `error` object instead of `result`.
   A task that runs longer than 120 seconds is delivered as failed.

Every callback is signed with the server's Ed25519 tool-integrity key under the
[Standard Webhooks](https://www.standardwebhooks.com/) asymmetric scheme:

```text
Webhook-Id: 5d0c6f1e-6a43-4c8e-9f0b-2f1d4c7b9a10
Webhook-Timestamp: 1792332192
Webhook-Signature: v1a,<base64 Ed25519 signature>
```

`Webhook-Id` is the `task_id`, `Webhook-Timestamp` is the Unix time in seconds
of the delivery attempt, and the signature covers the UTF-8 string
`<Webhook-Id>.<Webhook-Timestamp>.<raw body>`. Fetch `server_public_key` once
from `https://bitcoinstratigraphy.com/.well-known/integrity.json`, pin it, and
verify each callback against the exact body bytes before parsing it. Reject
timestamps more than five minutes old, accept only a `task_id` you received in
a 202, and process each `Webhook-Id` once. See
[docs/tool-integrity.md](docs/tool-integrity.md#webhook-callback-signatures)
for a Node.js verifier.

Delivery is best effort. The server makes up to three attempts, retries only
network errors and HTTP 408, 425, 429 and 5xx, never follows redirects, and
expects any 2xx answer. Each retry is signed again with a new timestamp. Tasks
are kept in server memory: a restart loses pending work, and there is no
endpoint to poll. This is not the MCP Tasks extension (`tasks/get`). Omit
`webhook_url` to keep the standard synchronous result.

Credentials with a `max_target` caveat still fetch the range before the 202, so
the caveat is enforced before the payment is used. The official MCP SDK clients
ignore 202 response bodies, so send webhook calls with a direct HTTP client such
as the `send` helper above.

## Configuration references

- [Cursor MCP integrations](https://cursor.com/help/customization/mcp)
- [Goose extensions and native configuration](https://block.github.io/goose/docs/getting-started/using-extensions)
- [ElizaOS MCP plugin character configuration](https://docs.elizaos.ai/runtime/services)
- [`mcp-remote` stdio bridge](https://www.npmjs.com/package/mcp-remote)