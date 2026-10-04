# Native framework agent quickstarts

All **15 canonical tools** are discovered through Streamable HTTP MCP at:

`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`

The examples connect natively, without the older custom Python client:

- `langchain_agent.py`: official `langchain.mcp.MCPAdapter`, FastMCP transport,
  and LangChain's current `create_agent` ReAct loop.
- `llamaindex_agent.py`: official `llama-index-tools-mcp` `BasicMCPClient`,
  `McpToolSpec`, and LlamaIndex workflow `ReActAgent`.

## Install and discover safely

Use a **separate consumer Python project** (Python 3.11 or newer). These optional
framework versions use MCP SDK 2.x; do not install them over the repository's
older MCP 1.x cookbook environment. The deployed Node API does not need them.
Install just the framework you intend to use:

```sh
python -m pip install -r requirements-langchain.txt
python langchain_agent.py

# Or, in your LlamaIndex consumer project:
python -m pip install -r requirements-llamaindex.txt
python llamaindex_agent.py
```

Download the matching script and requirements from `/cookbooks/frameworks/`.
Both scripts are standalone: no repository-local helper imports are required.
Default execution lists the public catalog only. It makes no model requests,
calls no paid tools, and pays no invoices. If discovery reports a missing
notarization tool or an older catalog, publish Phase 1 before running the demo,
or use `--url` / `STRATIGRAPHY_MCP_URL` to select an updated deployment.

## Option 1: inject a prepaid L402 Macro-Macaroon

Native MCP adapters are **not Lightning wallets**. Before running an agent:

1. With a trusted L402-capable wallet/client, request `proof.notarize` with
   valid `{ "hash": "<64-character SHA256 hex>" }` arguments and the header
   `X-L402-Batch-Size: 100`.
2. Inspect the HTTP 402 challenge. At the current base price the batch is
   **25,000 sats for 100 calls**, not 250 sats for the entire batch.
3. Explicitly approve payment in your wallet, validate the invoice amount and
   payment proof, and retain its macaroon plus valid preimage/payment proof.
4. Store the complete `L402 <macaroon>:<preimage>` authorization value as
   `L402_AUTHORIZATION` in your consumer project's secret store. Also configure
   `OPENAI_API_KEY` there. Do not commit, print, or put credentials in prompts.

The scripts attach `Authorization` and `X-L402-Batch-Size` through
`StreamableHttpTransport(headers=...)` for LangChain and
`BasicMCPClient(headers=...)` for LlamaIndex. **Do not use Bearer authentication.**
The batch header requests a batch; it does not prove payment or replenish quota.

Macro-Macaroons remain **tool-scoped**. A notarization credential cannot
authorize other paid tools, bypass expiry/revocation, or erase inherited limits.
Therefore both demos discover all 15 tools but give the agent only
`proof.notarize` and **free** `stratigraphy.list`. Expand that allowlist only
after configuring valid per-tool credentials or a budget-controlled wallet proxy.

```sh
python langchain_agent.py --run --hash <your-sha256-hex>
python llamaindex_agent.py --run --hash <your-sha256-hex>
```

Omit `--hash` to use the SHA256 of the documented quickstart sample text.
Omit `--model` to use `gpt-4.1-mini`. Agent execution incurs your model provider's
fees and consumes the paid notarization allowance. The scripts never purchase
passes themselves and stop rather than silently retrying payment failures.

## Option 2: connect to a local wallet proxy

Instead of setting `L402_AUTHORIZATION`, configure a trusted local proxy that
exposes **Streamable HTTP MCP**, forwards MCP negotiation/discovery/calls, and
handles upstream L402 challenges with **explicit spending budgets**, 100-call
batch requests, and the correct credential for each paid tool:

```sh
python langchain_agent.py --proxy-url http://127.0.0.1:8000/mcp --run
python llamaindex_agent.py --proxy-url http://127.0.0.1:8000/mcp --run
```

`L402_PROXY_URL` is the equivalent configuration variable. This toolkit does
not install or start a proxy. A generic HTTP forwarder does not handle Lightning
payments. Use proxy mode **or** direct credentials, never both.

## What the agent reports

The sample task combines notarization with the latest **indexed stratigraphy**
height. That index is not the live Bitcoin chain tip. `proof.notarize` returns
the original hash, portable detached `.ots` receipt bytes as hexadecimal, and
`otsStatus: "pending_calendar"`. Calendar acceptance is **not Bitcoin
confirmation**; upgrade and independently verify the receipt later.

Dotted MCP names are normalized to provider-safe underscore names only on the
framework wrappers. Their closures still call the original remote MCP tool,
so the server's credential scope and pricing stay unchanged.

## Official API references

- https://reference.langchain.com/python/langchain/mcp/adapter/MCPAdapter
- https://docs.langchain.com/oss/python/langchain/mcp/connections
- https://github.com/run-llama/llama_index/tree/main/llama-index-integrations/tools/llama-index-tools-mcp