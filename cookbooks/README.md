# Python framework cookbooks

Connect Python agents to the remote Bitcoin Stratigraphy server at
**https://bitcoin-stratigraphy-dashboard.replit.app/mcp**. No local server is
needed. MCP uses **Streamable HTTP**, not a legacy `/sse` transport.

The scripts default to **free discovery**. They do not ask an LLM to act, pay an
invoice, or read wallet credentials in that mode. Agent execution is opt-in with
`--run`, a model key, and an explicitly selected payment callback.

## Quickstart: free discovery in under 60 seconds

From the repository root, with Python available:

```sh
python -m pip install "httpx==0.28.1" "langchain-mcp-adapters==0.3.2"
python cookbooks/crewai_example.py
python cookbooks/langchain_example.py --payment-info
python cookbooks/autogen_example.py
```

The CrewAI and AutoGen commands validate the remote 14-tool catalog and fetch
free REST pricing. LangChain discovers real framework tools through
`MultiServerMCPClient` and optionally calls free `payment.get_info`.
No OpenAI key or wallet is required. Each command normally finishes in seconds;
network outages or uncached package downloads can take longer. LangChain has a
55-second overall timeout.

For the standalone HTTPX client only:

```sh
python cookbooks/l402_client.py
```

This calls free `payment.get_info`. The default API URL can be changed with
`--url https://your-server.example/mcp`; REST requests use that URL's origin.

### Dependencies for actual agent execution

Use **Python 3.11–3.13**; this repository's Python project requires **3.13**.
Install the supported LangChain/AutoGen dependencies before opting into agent execution:

```sh
python -m pip install -r cookbooks/requirements.txt
```

Alternatively, install only the framework you use:

```sh
# LangGraph ReAct agent (in addition to quickstart dependencies)
python -m pip install "langgraph==1.2.12" "langchain-openai>=1.6.7,<2"

# Modern AutoGen AgentChat — not the legacy pyautogen API
python -m pip install "autogen-agentchat==0.7.5" "autogen-ext[openai]==0.7.5"
```

Full framework installation can take longer than the lightweight discovery quickstart.

**CrewAI execution is temporarily unavailable in this workspace.** CrewAI's
dependency chain brings in ChromaDB releases with unresolved critical
vulnerabilities, including the latest release checked on October 2, 2026.
CrewAI and ChromaDB are therefore excluded from the shared project dependencies
and this requirements file. Do not reinstall that chain or bypass the publishing
security check. The CrewAI source example and free-discovery mode remain
available; native/paid execution needs a future safe upstream release.

### Run in this Replit workspace

The supported dependency set is already registered in `pyproject.toml` and
`uv.lock`, with a Python 3.13 project runtime. Use the project interpreter rather
than a different `python` binary that may still be on the shell's PATH:

```sh
uv run --no-sync python cookbooks/crewai_example.py
uv run --no-sync python cookbooks/langchain_example.py --payment-info
uv run --no-sync python cookbooks/autogen_example.py
uv run --no-sync python -m unittest cookbooks.test_l402_client -v
```

## Examples

### CrewAI: latest indexed telemetry and supplied ZK proof

The preserved `crewai_example.py` demonstrates two agents and two sequential tasks.
Native/paid execution requires a safe CrewAI release, which is currently unavailable:

1. Call **`stratigraphy.get`** with `days=1`, selecting the latest indexed record.
2. Call **`proof.verify`** with the exact arguments from `--proof-file`.

The requested descriptive names `stratigraphy.get_latest` and
`proof.verify_zk_proof` are **not registered tools**. These examples use the
actual canonical names, without adding server aliases.

CrewAI's native remote integration is demonstrated with
`Agent(mcps=[MCPServerHTTP(url=..., streamable=True, ...)])` and a free-only tool
filter. `--native-discovery` constructs that agent when a safe CrewAI release and a model key
are configured; it does not run the paid tasks.

Native `MCPServerHTTP` does not expose a documented custom HTTPX-client factory.
Therefore the paid tasks use `BaseTool` wrappers that call the remote MCP server
through the shared L402 client. Static headers alone do not implement invoice
settlement.

```sh
python cookbooks/crewai_example.py --run \
  --proof-file /path/to/real-proof-arguments.json \
  --pay-hook l402_client:lnd_pay_invoice
```

Provide a **real** Groth16 telemetry proof or drift proof, its exact public
inputs, and matching evidence. The file is a JSON object of `proof.verify`
arguments, not merely the proof bytes. Inspect the live tool's input schema with
the LangChain discovery command; supported OTS arguments are also recognized,
but an OTS receipt is not a ZK proof. These cookbooks do not generate dummy
proofs, fabricate verification keys, or claim successful verification without a
server result. Each Crew task permits only one paid tool invocation.

### LangChain + LangGraph: all 14 tools, four namespaces

`langchain_example.py` uses `MultiServerMCPClient` with
`transport="streamable_http"` and a supported `httpx_client_factory`. It
discovers and validates all canonical tools before giving them to a
LangGraph `create_react_agent`:

- **stratigraphy (5):** `list`, `get`, `get_digest`, `get_diff`, `get_range`.
- **proof (6):** `attenuate`, `verify`, `get_by_hash`, `list`, `submit`, `ground`.
- **mesh (2):** `get_status`, `broadcast`.
- **payment (1):** `get_info`.

The HTTPX factory handles L402 challenges, including async requests, without
pre-buffering live SSE streams. Each adapter session owns a fresh HTTP client;
all clients from the same factory share one invoice spending budget.

```sh
python cookbooks/langchain_example.py --run \
  --pay-hook l402_client:lnd_pay_invoice
```

The model sees underscore aliases such as `stratigraphy_get` because OpenAI
function names do not allow dots. The adapter still sends the canonical dotted
MCP names on the wire. All 14 tools, including state-changing `proof.submit` and
`mesh.broadcast`, are available in agent mode: enable it only for an authorized
agent. The demo prompt starts with free pricing discovery; it does not require
a paid call to produce an answer.

`create_react_agent` remains available but is deprecated in current LangGraph
in favor of LangChain's `create_agent`. It is used here to demonstrate the
specifically requested LangGraph ReAct interface.

### AutoGen: direct HTTP/REST tool

`autogen_example.py` builds a modern `AssistantAgent` with `FunctionTool`s.
Its data tool calls **GET `/api/v1/stratigraphy?days=1`** over HTTP, with L402
handled by the shared client. Free pricing uses **GET `/api/v1/cost`**.

```sh
python cookbooks/autogen_example.py --run \
  --pay-hook l402_client:lnd_pay_invoice
```

Add `--proof-file /path/to/real-proof-arguments.json` to expose an additional MCP
proof-verification tool. Without that flag, no proof input is required or
invented. Synchronous REST/MCP calls run off the async event loop, and the model
client is closed after execution.

All agent examples require `OPENAI_API_KEY` in your secure environment;
`OPENAI_MODEL` optionally overrides the default `gpt-4.1-mini`. Model billing is
separate from the server's Bitcoin invoice charges.

## L402 payment callbacks

`l402_client.py` provides a standalone `BitcoinStratigraphyClient` that wraps
HTTPX and works without any agent framework. Its callable payment contract is:

```python
from cookbooks.l402_client import BitcoinStratigraphyClient, L402Challenge

# Pass your real wallet adapter, not a stub. Its signature is:
# pay_invoice(challenge: L402Challenge) -> str
# Return the settled invoice's 64-character hex payment preimage.
#
# client = BitcoinStratigraphyClient(pay_invoice=pay_invoice)
# client.call_tool("stratigraphy.get", {"days": 1})

with BitcoinStratigraphyClient() as client:
    print(client.call_tool("payment.get_info", {"action": "query"}))
```

The callback receives the invoice, selected payment hash, amount, request URL,
and MCP tool name where applicable. Connect an existing **NWC** wallet adapter
or **Lightning RPC** client to this callback. For a standard successful NIP-47
`pay_invoice` reply, the preimage is `reply["result"]["preimage"]`; a returned
invoice ID, UUID, or outgoing-payment reference is **not** a preimage and is
rejected. No NWC secret is automatically consumed.

CLI callbacks use `--pay-hook importable_module:function`. A real LND REST
adapter is included as `l402_client:lnd_pay_invoice`. Configure these securely
before selecting it:

- `LND_REST_URL`: HTTPS URL of your LND REST endpoint.
- `LND_MACAROON_HEX`: wallet macaroon with payment permission.
- `LND_TLS_CERT`: optional path to your LND TLS CA/server certificate.

The LND adapter calls `/v1/channels/transactions`, checks payment failure, and
decodes LND's base64 payment preimage. It caps its routing fee at **5 sats**.
TLS verification remains enabled; custom wallet adapters must enforce their
own fee limits and wallet permissions. Never commit wallet credentials.

### Payment safeguards and limits

- Parse `WWW-Authenticate: L402 macaroon="...", invoice="..."` and require its
  values to match the challenge JSON body.
- Decode the BOLT11 amount/payment-hash tag and checksum; require them to match
  the body. The wallet is responsible for invoice signature/expiry validation.
- Enforce **250 sats per invoice** and **1,000 invoice sats per run** by default.
  Override with `--max-sats` and `--budget-sats`. Routing fees are additional.
- Serialize wallet callbacks, reserve the budget before settlement, and verify
  `SHA256(preimage) == payment_hash` before sending any credential.
- Retry the **same HTTP request once** with
  `Authorization: L402 <macaroon>:<preimage>`.
- Never cache or share single-use paid credentials between tool invocations.
  A second 402 fails explicitly without paying another invoice.
- Do not pay for MCP initialization/discovery, unknown tool names, or a
  different origin. Redirects are not automatically followed.
- Do not release a reservation after an ambiguous wallet failure. Reconcile
  timeouts with your wallet before trying the operation again: an invoice may
  already be paid even if redemption did not complete.

This client implements **Bitcoin Lightning L402 only**. It does not implement
x402 USDC, Liquid, Taproot Assets, or CoinOS internal UUID-reference redemption.
Check live `payment.get_info` and REST `/api/v1/cost` rather than assuming every
tool or payment rail has the same availability or price.

## Offline verification

```sh
python -m unittest cookbooks.test_l402_client -v
```

Tests use synthetic, non-payable invoices and HTTPX mock transports. They cover
challenge consistency, preimage binding, budgets, sync/async retries, single-use
credentials, MCP initialization, tool errors, catalog validation, and SSE
streaming. No real wallet, payment, or model call is made.

HTTP clients use the system TLS trust store. If a corporate/development proxy
uses a private CA, configure the trusted CA rather than disabling verification.

## Official framework references

- [CrewAI remote MCP](https://docs.crewai.com/en/mcp/overview).
- [LangChain adapter HTTP client factory](https://reference.langchain.com/python/langchain-mcp-adapters/sessions/StreamableHttpConnection).
- [LangGraph ReAct API](https://reference.langchain.com/python/langgraph/prebuilt/chat_agent_executor/create_react_agent).
- [AutoGen AgentChat tools](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html).
- [AutoGen model clients](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/models.html).