# Bitcoin Stratigraphy MCP Client

**Identity-bound Streamable HTTP for enterprise AI orchestration.**

`bitcoin-stratigraphy-mcp-client` adds NIP-98 Schnorr authentication and an explicit
L402 wallet handoff to the official MCP Python SDK. LangChain, CrewAI integrations
that consume MCP sessions, and framework-independent orchestrators retain the
standard MCP protocol. The adapter does not implement or modify server tools,
fleet routing, treasury limits, or settlement policy.

## Install

Python 3.10 or newer is required. This distribution is supplied as source; it has
not been published to PyPI.

```bash
python -m pip install './sdk/python/mcp-client[langchain]'
```

The existing `bitcoin-stratigraphy-enterprise` distribution in `sdk/python`
remains independently installable. Both packages can coexist.

## LangChain integration: four lines

Provide `private_key` as a 64-character hexadecimal Schnorr secret from your secret
manager, an async `wallet_handler` following the contract below, and a configured
LangChain `model`. Install LangChain and your chosen model provider separately.

```python
from bitcoin_stratigraphy_mcp_client import L402Nip98Transport
from langchain.agents import create_agent
async with L402Nip98Transport(private_key, wallet_handler).langchain_tools() as tools:
    agent = create_agent(model, tools=tools)
```

Run `await agent.ainvoke(...)` **inside the same context** so the MCP session stays
open while tools execute. The helper loads tools from a real `mcp.ClientSession`,
not a replacement agent or a mock tool catalog. For CrewAI, use its supported MCP session/tool
adapter rather than passing LangChain tools directly to a CrewAI agent.

## Wallet contract and payment safety

```python
from bitcoin_stratigraphy_mcp_client import L402Challenge, L402Nip98Transport

async def wallet_handler(challenge: L402Challenge) -> str:
    # Your orchestrator owns invoice decoding, spend approval and wallet credentials.
    # Validate the invoice's payment hash, amount, destination/network and expiry.
    # Enforce your own per-payment and cumulative budget before authorizing payment.
    return await approved_wallet.pay_invoice(challenge.invoice)
```

`approved_wallet` is your application's wallet implementation, not a bundled
wallet service. The handler receives the **macaroon**, **Lightning invoice**,
**payment hash**, and optional quoted **amount_sats**. It returns the payment's
32-byte preimage as hexadecimal; raising an exception declines payment. The
quoted amount is untrusted metadata, not a wallet spending authorization.

The transport:

- Signs every HTTP attempt with a NIP-98 kind-27235 event using BIP-340
  Schnorr signatures from libsecp256k1 via `coincurve`.
- Binds the exact HTTPS URL, method, and non-empty request bytes. A fresh nonce
  avoids same-second event-ID collisions on replay-protected routes.
- Uses `X-Nostr-Authorization` for identity and reserves `Authorization` for
  `L402 <macaroon>:<preimage>`, so the two mechanisms coexist.
- Requires matching header/body challenge fields and verifies the returned
  preimage against the challenge payment hash before sending it.
- Makes at most one paid retry, preserving the original request bytes and signing
  a fresh event. It never retries ordinary network failures or other HTTP errors.
- Serializes wallet calls, deduplicates an identical invoice challenge within the
  transport's bounded in-memory proof cache, and times out the wallet after
  120 seconds by default. Wallets must independently deduplicate payments across
  processes and resolve uncertain/cancelled payments before paying again.
- Refuses other endpoints, redirects, externally supplied auth headers, and
  malformed or oversized L402 challenges. Keys, invoices, macaroons and preimages
  are not logged by this package; configure your own HTTP logging accordingly.

The production endpoint defaults to **https://bitcoinstratigraphy.com/mcp**.
Construct a new transport for each client/session lifetime. Closing it clears
cached payment proofs and closes its underlying HTTP transport.

## Official MCP client and framework factory hook

`L402Nip98Transport` subclasses `httpx.AsyncBaseTransport`, the official MCP
SDK's HTTP extension surface. Its `session()` context manager owns the HTTP
client, invokes `mcp.client.streamable_http.streamable_http_client`, initializes
`mcp.ClientSession`, and closes all resources on exit. SSE and JSON response
handling remain with the official SDK.

Alternatively, use `transport.http_client_factory` as the
`httpx_client_factory` hook in a LangChain Streamable HTTP connection. Supply a
new transport per framework connection; do not reuse a closed factory across
`get_tools()` and subsequent independent sessions. Direct session integration
above avoids that lifecycle ambiguity.

The adapter handles invoice-bearing L402 challenges only. Hashcash admission
challenges without an L402 invoice fail explicitly; they do not trigger wallet
payments. Fleet registration, NWC pairing, wallet funding and server-side credit
qualification remain separate application responsibilities. A returned L402
credential is never assumed to override the Treasury Firewall.

## Verification

The tests use public fixture keys and mocked HTTP only; no network, database,
funded wallet, production credentials or backend test changes are required.

```bash
PYTHONPATH=sdk/python/mcp-client/src python -m unittest discover -s sdk/python/mcp-client/tests -v
cd sdk/python/mcp-client && python -m mypy src
```

NIP-98-only tests can run independently without LangChain:

```bash
PYTHONPATH=sdk/python/mcp-client/src python -m unittest discover -s sdk/python/mcp-client/tests -p test_nip98.py -v
```

The optional LangChain integration test requires the `langchain` extra.

## Licensing

Created & Architected by Charles R. Strogish.
Copyright (c) 2026 Charles R. Strogish.

Dual-licensed under AGPL-3.0-only or a separately executed commercial license.
See the parent SDK's [enterprise terms](../LICENSE.md) and the repository license.
API payments do not grant commercial software rights.
