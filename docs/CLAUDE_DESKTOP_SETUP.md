# Claude Desktop Setup

Connect Claude Desktop to the **Bitcoin Stratigraphy Data Engine MCP** without
installing or changing the server.

| Setting | Value |
| --- | --- |
| Public MCP URL | `https://bitcoin-stratigraphy-dashboard.replit.app/mcp` |
| Remote transport | Streamable HTTP |
| Supported protocol | MCP `2025-11-25` |
| Tool catalog | 14 tools; retrieve the current catalog from the server |
| Connection-time wallet requirement | None |
| Paid execution | L402 Lightning micropayments; requires a separate payment integration |

The configuration below starts a local **stdio-to-HTTP bridge** called
`mcp-remote`. The actual MCP server remains hosted at the public URL. A wallet
is not configured, and the bridge does not automatically pay invoices.

## 1. Install the prerequisites

1. Install or update [Claude Desktop](https://claude.ai/download) for macOS or
   Windows. This guide is for Claude Desktop chat, not Claude Code.
2. Install a currently supported [Node.js LTS release](https://nodejs.org/),
   including npm and `npx`.
3. Check these commands in Terminal, PowerShell, or Command Prompt:

   ```sh
   node --version
   npm --version
   npx --version
   ```

4. Ensure your machine can reach the public MCP URL over HTTPS and access npm
   to download the bridge. Do not disable TLS verification to work around a
   corporate proxy; configure the organization's trusted certificate chain.

You do not need to clone this repository, run a local API server, configure
Nostr keys, or add the service operator's wallet credentials.

## 2. Open the correct configuration file

In Claude Desktop's application settings, select **Developer → Edit Config**.
This creates or opens `claude_desktop_config.json`. These are the usual paths:

| Operating system | File |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Back up an existing file before editing it. Do not replace unrelated settings
or other MCP server entries. Use a plain-text editor and save as JSON, not as
`claude_desktop_config.json.txt`.

## 3. Add the remote server through the bridge

If the configuration is empty, use:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

If you already have an `mcpServers` object, add only the
`bitcoin-stratigraphy` entry inside it. Keep exactly one `mcpServers` key.
JSON does not allow comments, trailing commas, or single-quoted strings.

### What each setting means

- **`bitcoin-stratigraphy`** is the local display/configuration name.
- **`command`** launches `npx` on your computer, not on the remote server.
- **`-y`** allows npm to install the bridge without an interactive confirmation.
  It does **not** approve tool execution or authorize Lightning payments.
- **`mcp-remote`** is the bridge package. For managed environments, review it and
  replace this with `mcp-remote@<reviewed-version>` using a real version your team
  has tested. The unpinned example is convenient for initial setup.
- **The URL** is the live Streamable HTTP MCP endpoint. Do not use the website
  root, `/sse`, a development URL, or an API telemetry route.
- **`--transport http-only`** prevents accidental fallback to the older SSE
  transport. Streamable HTTP can still carry SSE-formatted response bodies;
  that does not make it a legacy `/sse` service.

Do not add an `Authorization` header, NWC URI, macaroon, or payment preimage to
this basic configuration. Discovery is public, and paid credentials are
short-lived, request-scoped, and unsuitable as a permanent bridge header.

### Windows command-resolution issues

Start with `"command": "npx"` as above. If Claude reports `ENOENT` or cannot
locate the command, run `where.exe npx` and use the installation's absolute path
if your desktop version supports launching it. Windows paths in JSON must
escape backslashes, for example:

```json
{
  "mcpServers": {
    "bitcoin-stratigraphy": {
      "command": "C:\\Program Files\\nodejs\\npx.cmd",
      "args": [
        "-y",
        "mcp-remote",
        "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

That is a common installation path, not a guarantee. If launching a `.cmd` file
is unsupported in your desktop release, use the documented Windows launcher
for that release or an administrator-reviewed command wrapper. Do not blindly
copy a path that does not exist.

On macOS, use `command -v npx` to locate an absolute executable path if Claude's
GUI does not inherit your shell's Node.js version-manager environment.

## 4. Save and fully restart Claude Desktop

1. Save the file.
2. Quit Claude Desktop completely, including a background/tray instance if
   present. Closing one window may not terminate the application.
3. Reopen Claude Desktop and allow time for the first npm download.
4. Open the MCP/connector management area and find `bitcoin-stratigraphy`.
   Labels vary by desktop version; check **Developer** settings or the
   conversation's **Connectors / Manage connectors** menu.
5. Inspect the available tools. The current server exposes 14 tools. A future
   catalog change should be checked against the live server rather than hidden.

## 5. Verify with free, read-only requests

Start with these prompts:

> Use bitcoin-stratigraphy's stratigraphy.list tool to show the available
> dataset bounds. Do not call any paid tools.

> Call payment.get_info with action query to show current tool prices. Do not
> request settlement, pay an invoice, or call a paid tool.

Approve only the matching tool invocation when Claude asks. The equivalent
arguments for pricing discovery are:

```json
{
  "action": "query"
}
```

For one tool's price, the pricing request arguments are:

```json
{
  "action": "query",
  "toolName": "stratigraphy.get_digest"
}
```

This asks for a price; it does not invoke `stratigraphy.get_digest` and does not
issue an invoice. Dataset heights are indexed historical selections, not a
promise of real-time Bitcoin-tip coverage.

## 6. Understand paid calls before enabling them

Paid calls receive HTTP **402 Payment Required** when no valid L402 credential
is supplied. A plain Claude Desktop + `mcp-remote` setup may display this as a
tool/transport error. That is not fixed by repeatedly approving the tool.

- Claude's tool approval is separate from wallet spending authorization.
- Standard `mcp-remote` does not include an L402 wallet or invoice payer.
- A paying agent runtime needs an L402-aware client/transport and an
  explicitly authorized, budget-limited Lightning wallet.
- Keep wallet secrets outside the desktop JSON. Never reuse service/operator
  wallet credentials or paste an invoice preimage into a prompt.
- Inspect live prices with `payment.get_info` before deciding on a budget.
- `proof.submit` and `mesh.broadcast` have side effects. Payment permission
  does not automatically authorize those operations.

For an automated payer, see [L402 Agent Payments](L402_AGENT_PAYMENTS.md).
For custom Python agent runtimes, see
[LangChain and CrewAI Integration](LANGCHAIN_CREWAI_GUIDE.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Server does not appear | Correct filename/path, valid JSON, no duplicate `mcpServers`, full restart. |
| `ENOENT` / command not found | Node.js/npm installation and Claude's executable search path; use a verified absolute path. |
| First connection takes time | npm download and corporate network access; inspect logs before restarting repeatedly. |
| HTTP 404 | Exact HTTPS `/mcp` URL, not `/sse` or a development URL. |
| HTTP 402 | Tool is paid; no payer is installed by this guide. Read the payment guide. |
| HTTP 429 | Back off and honor `Retry-After` when present; stop rapid retries. |
| TLS/certificate error | Correct system time, trusted CA chain and proxy configuration; keep certificate verification on. |
| Request rejected / validation error | Inspect the tool's current input schema; use canonical, case-sensitive tool names. |
| Tool reports failure with HTTP 200 | MCP `isError` or JSON-RPC error still indicates failure; inspect the result, not just HTTP status. |

### Logs and a bridge diagnostic

Claude Desktop MCP logs are usually located at:

- macOS: `~/Library/Logs/Claude/`
- Windows: `%APPDATA%\Claude\logs\`

Look for `mcp.log` and `mcp-server-bitcoin-stratigraphy.log`. Share only redacted
errors: remove wallet URIs, Authorization headers, tokens, macaroons, preimages,
and sensitive tool arguments.

To test whether the bridge can start independently of Claude:

```sh
npx -y mcp-remote https://bitcoin-stratigraphy-dashboard.replit.app/mcp --transport http-only
```

This is a stdio bridge, so it may remain running while waiting for an MCP client
to send messages; it is not an interactive shell. Stop it with `Ctrl+C` before
restarting Claude. A successful launch alone is not proof that a tool call
succeeded.

## Remove or disable the connection

Disable the connector in Claude's UI, or remove just the
`bitcoin-stratigraphy` entry from `mcpServers` and restart. Removing the bridge
configuration does not revoke a separately configured wallet connection;
revoke that connection in your wallet if it is no longer needed.

## References

- [Official MCP guide: connect local servers with Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [mcp-remote bridge documentation](https://github.com/geelen/mcp-remote)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Project connection reference](../CONNECT.md)
- [Live MCP server card](https://bitcoin-stratigraphy-dashboard.replit.app/.well-known/mcp/server-card.json)