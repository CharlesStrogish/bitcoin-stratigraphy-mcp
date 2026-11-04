# bitcoinstratigraphy-agent-yield

One-call Python onboarding for Bitcoin Stratigraphy MCP tools: HTTPX discovery,
automatic bounded L402 retries, durable spending reservations, and the same
stderr terminal receipts as `@bitcoinstratigraphy/agent-yield`.
Version **0.3.0** introduces server-signed payload enforcement.
The previously published 0.2.0 package does not include it.

Install from PyPI:

```sh
pip install bitcoinstratigraphy-agent-yield
```

For local development, install from this checkout:

```sh
pip install ./packages/python-agent-yield
```

## Two-line quick starts

Start with your existing `agent_config`. Its `fiduciary` policy is the explicit
wallet authorization shown below. No wallet is created, connected or funded
by installing or importing this package.

### LangChain

```python
from bitcoinstratigraphy_agent_yield import with_fiduciary_yield

agent = with_fiduciary_yield({**agent_config, "framework": "langchain"})
```

Pass `agent["tools"]` to `langchain.agents.create_agent(model=..., tools=...)`.
Existing tools are preserved; discovered tools are native `StructuredTool`s
with sync `.invoke()` and async `.ainvoke()`.

### CrewAI

```python
from bitcoinstratigraphy_agent_yield import with_fiduciary_yield

agent = with_fiduciary_yield({**agent_config, "framework": "crewai"})
```

Pass `agent["tools"]` to `crewai.Agent(role=..., goal=..., backstory=..., tools=...)`.
They are native CrewAI `BaseTool`s. You can also wrap an existing public-tools
CrewAI agent with `with_fiduciary_yield(existing_agent, fiduciary=policy)`;
this returns a copy, never mutating the original agent.

### AutoGen

```python
from bitcoinstratigraphy_agent_yield import with_fiduciary_yield

agent = with_fiduciary_yield({**agent_config, "framework": "autogen"})
```

Pass `agent["tools"]` to `autogen_agentchat.agents.AssistantAgent(..., tools=...)`.
These are native `autogen_core.tools.BaseTool`s, not OpenAI descriptors requiring
a separate dispatcher. Cancellation is checked before starting execution.

Framework imports are lazy. Install your chosen framework separately; the base
wheel has **four direct runtime dependencies**:
HTTPX, bech32, coincurve and cryptography. No LangChain, CrewAI, AutoGen, NWC or MCP framework
is forced on other consumers. Native adapters target the current public
LangChain Core 1.x, CrewAI 1.x and AutoGen Core 0.7 APIs.

## Explicit wallet and spending policy

```python
policy = {
    "server_public_key": independently_trusted_server_public_key_pem,
    "wallet": authorized_wallet,
    "max_payment_sats": 500,
    "max_total_sats": 5000,
    "fee_reserve_sats": 10,
    "state_directory": ".agent-yield-state",
}
agent_config = {"tools": existing_tools, "fiduciary": policy}
```

`authorized_wallet.pay_invoice(bolt11)` is a **synchronous** wallet adapter
returning `{"preimage": "<64 hex characters>", "fees_paid": 0}`.
`fees_paid` is optional integer millisatoshis. Use your wallet provider's
authorized SDK inside the adapter; secrets never belong in prompts, source,
HTTP headers, terminal receipts, or tool arguments. This scaffold does **not**
implement NWC wallet transport.

Without a wallet and explicit positive budgets, discovery and free tools work;
paid execution fails closed. Optional `make_invoice(amount_msats)` returns
`{"invoice": "<receiving BOLT11>"}` to enable automatic yield withdrawals.
Wallet adapters must enforce their own operation timeouts and fee ceiling:
Python cannot cancel an external payment already submitted to a wallet.

`agent["fiduciary"]` exposes `.list_tools()`, `.call_tool(name, arguments)`,
`await .acall_tool(name, arguments)`, `.recover_claim(payment_hash)`, and
`.close()`. Framework tools are added to a configuration before constructing a
graph/AssistantAgent; this does not retrofit private internals of running agents.
Async execution offloads synchronous HTTP/wallet work to a worker thread.
Cancelling the awaiting task does not reverse an in-progress wallet operation.
Close the config's client at application shutdown. For public-tools object
wrapping, supply an application-owned `http_client` and close it yourself.

## Fiduciary Armor (0.2)

Add `"max_spend_sats": 5000` to your `fiduciary` policy; **5000 sats** is the
default. This in-memory, thread-safe session breaker is independent of the
existing durable wallet budgets. Each payment reserves invoice principal plus
the configured fee allowance before wallet access. Reported routing fees count
toward session spend; unreported fees and uncertain payments conservatively
retain their reservations. Wallet adapters must enforce their own fee ceiling.
Excess reported fees block future durable spending and can latch the session cap.

Exhausted sessions throw
`CircuitBreakerError: Maximum authorized thermodynamic spend reached.`
before another outbound tool request. If the price is unknown, one unpaid 402
quote may be needed; an oversized quote latches the breaker before wallet access
or a paid HTTP retry. All later tool requests are blocked. Public discovery and
recovery of existing claims remain available, and already-admitted payments can
finish within their reservations. A new client starts a new session, but the
durable ledger still prevents resetting wallet authorization.

Every successful sync/async/framework tool now returns a JSON-serializable
`TruthReceipt` dictionary with attribute access for the four main fields:

```python
receipt = agent["fiduciary"].call_tool("proof.verify", arguments)
data = receipt.payload  # previous return value
# receipt.thermodynamic_cost: exact decimal-string sats (invoice principal)
# receipt.timestamp: UTC client-observed settlement time
# receipt.cryptographic_proof: verified payment preimage
# receipt["provenance_verified"]: True (server payload signature verified)
```

The additional `payment_hash` verifies the preimage and `payload_sha256` is a
local digest of this SDK's JSON serialization of the returned payload.
**Payment proof is not a signature over the data or proof of Bitcoin anchoring.**
`evidence_scope` describes the payment evidence only.
Separately, every successful SDK tool call verifies the server's Ed25519 HTTP
signature using your independently pinned `server_public_key` (SPKI PEM), before
parsing or returning a `TruthReceipt`. This includes free/Genesis calls.
`provenance_verified` is `True` only on SDK-verified results; manually constructed
receipts default to `False`. A missing pin or missing, invalid or tampered signature
raises `FiduciaryTamperingError: Data payload signature verification failed.`
Discovery does not require a pin.

See [payload attestations](../../docs/payload-attestations.md) for the protocol,
server configuration and key rotation. This proves server origin and byte
integrity, not factual accuracy, freshness, Bitcoin anchoring or an AI's later
interpretation.
Free/Genesis calls have zero observed cost and null payment proof, scope
`payment_not_observed`, and a receipt-observation timestamp. Externally supplied
credentials also have no new SDK-observed payment. Old paid records without a
stored time retain a null timestamp and `timestamp_kind: "unknown"`.

Treat receipt preimages as sensitive; do not send them to public logs or prompts.
Yellow/green stderr receipts include remaining circuit capacity, never proofs.
The private SQLite ledger upgrades existing files to retain observed settlement
times without inventing timestamps for historical payments.
This return-shape change is available in **0.2.0**. Building does not publish updates.

### Transport and settlement

- Discovers the live paginated catalog at `https://bitcoinstratigraphy.com/mcp`.
  Handles MCP `2026-07-28`, JSON and SSE, bounded response sizes, timeout and
  one bounded Hashcash admission retry. Discovery never pays a wallet.
- Validates mainnet BOLT11 checksum, recoverable signature, explicit payee,
  amount, expiry and payment hash against the HTTP JSON quote before spending.
- Reserves invoice principal plus fee allowance in private SQLite storage
  **before** contacting the wallet. Per-invoice and cumulative limits are
  integer satoshis. Reservations survive threads, processes and restarts.
  Reported excessive/invalid fees block future new payments.
- Verifies every preimage against its invoice hash, then retries the identical
  MCP body/ID exactly once with `Authorization: L402 macaroon:preimage`.
  Credentials are bound to the exact invoice/request, not globally reused
  across unrelated tools. A repeated 402 never triggers a second payment.
- Never follows redirects or replaces caller-supplied payment credentials.
  Supply `identity_headers(url, method, body_bytes)` for fresh NIP-98 headers;
  it runs again for admission and paid retries. Valid Genesis Grant calls incur
  no payment, paid-history credit, yield allocation or earned receipt.
- Unknown payments and invalid returned proofs stay reserved. **Do not delete
  the state directory or change directories to retry a payment.** Operators
  must establish the payment outcome before recovery. Use private persistent
  storage, exclude it from Git, and use one directory per wallet and policy.

The SQLite ledger contains sensitive payment proofs, though never wallet keys.
The folder is created with mode 0700 and the database with 0600. Protect and
back up this directory. Existing directories must already be private.
This is client-side accounting, not a replacement for server-side settlement
ledgers or a wallet-enforced spending limit.

## Terminal receipts

On a successful paid execution with a receiving wallet:

```text
[Bitcoin Stratigraphy] ⚡ Thermodynamic Yield Allocated: 21 Sats (settlement pending).
[Bitcoin Stratigraphy] ⚡ Thermodynamic Yield Earned: 21 Sats routed to agent wallet.
```

Allocated is yellow; earned is green. An earned receipt appears **only** after
the claim API confirms `SETTLED` **and** `payment_sent: true`, never on
allocation, free grants, pending claims, failed tools or failed payouts.
Millisatoshi precision is preserved. Logging goes exclusively to `sys.stderr`
to preserve MCP JSON-RPC stdout. `QUIET_STRATIGRAPHY=true` disables receipts at
event time; logging failures never change successful tool results.

Claims are best effort, not guaranteed income. `on_error({"code": ...})`
reports recovery needs without exposing wallet/server error text.
`on_yield_claim({"status": ..., "amount_msats": ...})` observes claim status.
`.recover_claim(payment_hash)` replays only a persisted withdrawal request and
never buys a new tool invoice. Recovery after a crash during receiving-invoice
creation needs operator intervention; it does not create a second invoice.
Claims run synchronously after paid execution, bounded by the HTTP timeout.

## Development / packaging (no publication)

From the repository root, using its Python environment:

```sh
uv run --no-sync python -m pytest packages/python-agent-yield
cd packages/python-agent-yield
uv run --no-sync python -m hatchling build -d ../../generated-artifacts/python-agent-yield
```

Or install `.[test]` inside this package, then run `python -m pytest`.
The dedicated tests use signed synthetic invoices, `httpx.MockTransport`,
temporary state, and fake wallets. They do not contact mainnet or move funds.
Native LangChain/AutoGen integration tests run when those frameworks are
installed; the CrewAI adapter has a public-API contract fixture without pulling
CrewAI's full dependency tree into this standalone package.
Wheel/sdist build output belongs in `generated-artifacts/`, never source control.
Building never uploads to PyPI; publication is an explicit release step.
