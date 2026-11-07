# bitcoin-stratigraphy-starter-swarm

**Fork this repo, add your keys, and instantly run an autonomous agent with 21% thermodynamic yield, L402 circuit breakers, and Ed25519 Truth Receipts.**

## A2A clearing extension

The starter now includes an isolated clearing registry and NWC payer. See
[CLEARING.md](CLEARING.md) for setup, exact tool names, payment limits, and
retry behavior. **Contract creation automatically spends real sats while
settlement remains unavailable.** No core data or staking lookup logic changes.

Give your first agent a real spending policy—not unlimited access to your wallet.
This standalone Python template connects LangChain and OpenAI to Bitcoin
Stratigraphy's canonical `stratigraphy.get_digest` tool through the public
`bitcoinstratigraphy-agent-yield==1.1.0` SDK.

One command starts the agent. One canonical query returns a verified receipt.
A **hardcoded 1,000-sat Fiduciary Armor circuit breaker** shows how much spending
capacity remains. Eligible paid calls also trigger the SDK's **21% yield claim**
flow in withdrawal mode, with the actual claim status printed separately.
Yield staking and authenticated escrow lookup are native SDK features, including
through `FiduciaryClient` and `with_fiduciary_yield` framework adapters.

## 1–2–3 Quickstart

### 1. Fork and install

Use **Python 3.11+**. Fork this repository, then:

```sh
cd starter-swarm-python
python -m pip install -r requirements.txt
cp .env.example .env
```

You can also copy this directory into a new repository. It has **no imports from
the core API, no workspace dependency, and no server to deploy**.
`langchain-openai` is included because modern LangChain ships its OpenAI model
connector separately from `langchain` and `openai`.

### 2. Add your keys and trusted server pin

Edit your local `.env`:

| Setting | What to supply |
| --- | --- |
| `OPENAI_API_KEY` | Your OpenAI API key |
| `OPENAI_MODEL` | A tool-capable model; defaults to `gpt-4.1-mini` |
| `LND_REST_URL` | Your funded mainnet LND node's HTTPS REST origin |
| `LND_MACAROON_HEX` | Hex-encoded LND macaroon with payment and invoice permissions |
| `LND_TLS_CERT_PATH` | Local LND certificate/CA file; blank only for system-trusted TLS |
| `STRATIGRAPHY_SERVER_PUBLIC_KEY_PATH` | Path to the operator's independently trusted Ed25519 SPKI PEM |
| `STRATIGRAPHY_YIELD_MODE` | `stake` or `withdraw`; omitted means `withdraw` for legacy compatibility |
| `STRATIGRAPHY_NOSTR_PRIVATE_KEY` | Dedicated agent-owned 32-byte hex Nostr key; required for staking and escrow lookup |

Use a dedicated low-balance wallet and restricted LND macaroon. The included
adapter supports **LND REST**, not NWC, LNbits, or a wallet seed phrase. It sends
payments through `/v2/router/send` with a **10-sat routing-fee ceiling**
and creates exact-millisatoshi receiving invoices through `/v1/invoices`.
Your node must be reachable and have outbound and inbound Lightning liquidity.

Get the server public key from the operator through an independently trusted
channel and save it as `server-public-key.pem`. The key is public, not a wallet
credential. Do not automatically trust the API's discovery key: that defeats
independent verification. SDK 1.1.0 also requires the hosted API to support signed
responses; an unsigned deployment fails closed rather than returning fake proof.

Never commit `.env`, wallet macaroons, or the private payment ledger. Local ignore
rules are included. Existing environment variables override `.env`; keep secrets
out of shared terminals, tracing services, and prompts.

### 3. Run your armored agent

```sh
python main.py
```

This authorizes **real mainnet payments** within the configured limits.
The agent selects its tool, the SDK handles the exact L402 payment challenge,
and the terminal prints:

- The actual `TruthReceipt`, including `provenance_verified: true`, returned
  payload, observed cost, timestamp, and payload digest.
- Remaining Fiduciary Armor capacity out of **1,000 sats**.
- A separate yield claim status when a paid call is eligible.
- A short agent-written summary of the indexed Bitcoin dataset.

Receipt values come from execution, not example numbers. Payment preimages are
redacted from terminal output and never passed to the language model. The
single-query tool reuses its successful receipt if the model calls it again.
If no tool call occurs, the program fails rather than claiming success.

## 1-Click Yield Staking (VIP Compute)

Agents can now park their 21% thermodynamic yield inside the Central Bank's
escrow by setting `STRATIGRAPHY_YIELD_MODE=stake`.

The new `.env.example` opts into `stake`; fill in a dedicated
`STRATIGRAPHY_NOSTR_PRIVATE_KEY` before running it. Existing `.env` files that
omit the mode retain `withdraw` behavior, including the SDK's existing eligible
Lightning claim flow. Invalid modes and staking without an identity fail before
wallet or HTTP activity. No wallet seed or server private key is required.
Staking also requires a server that advertises `payment.get_escrow`; the client
refuses paid calls in stake mode against an older catalog instead of assuming
an old server honored the new header. Default withdrawal mode remains compatible
with those older catalogs. Deploy the server's staking code and database
migration before opting a client into staking.

The client sends `X-Yield-Mode` on discovery, invoice admission, paid retries,
and withdrawal claim requests. In stake mode, it signs the initial paid request
and each retry with a fresh, exact-request NIP-98 event and does **not** create a
receiving invoice or submit a competing withdrawal claim. The server credits
settled, owner-bound receipts exactly once; an invoice or a failed request alone
does not establish a new balance. Changing back to `withdraw` affects future
calls, not previously staked capital. This client does not implement unstaking.

`get_escrow()` and `call_tool("payment.get_escrow", {})` return only:

```json
{
  "pubkey": "<authenticated agent's Nostr public key>",
  "staked_sats": 10001,
  "vip_status": true,
  "unlocked_features": ["zero_latency_routing"]
}
```

These are illustrative values, not a promised balance. `vip_status` is true
strictly above 10,000 whole staked sats. The server currently returns
`zero_latency_routing` as an informational architecture label, even for a zero
balance: **it does not activate zero-latency priority routing, expanded context
limits, or a payment bypass.** Those compute features remain planned, not an
implemented guarantee.

The existing server implements this utility as a **JSON-RPC MCP POST to `/mcp`**,
not an HTTP GET route. NIP-98 identity uses **BIP-340/Schnorr on secp256k1**;
Ed25519 is the separate server-response signature verified against your pin.
Every lookup binds its URL, POST method, timestamp, nonce and exact body bytes.
The client rejects mismatched identities, malformed four-field responses,
unverified server signatures and redirects. A lookup never pays an unexpected
402 invoice and remains available when the spending budget is exhausted.

For application code running from this directory:

```python
from pathlib import Path
from dotenv import load_dotenv
from staking import YieldSettings, YieldStakingClient

load_dotenv(override=False)
with YieldStakingClient(
    yield_settings=YieldSettings.from_env(),
    server_public_key=Path("server-public-key.pem").read_text(),
    max_spend_sats=0,  # Read-only lookup needs no spending authorization or wallet.
) as client:
    balance = client.get_escrow()
    print(balance)
```

When an agent identity is configured, the starter also exposes a narrow
LangChain `get_escrow` tool alongside the existing digest tool. It never exposes
wallet operations or arbitrary MCP calls to the language model. The base
`bitcoinstratigraphy-agent-yield==1.1.0` dependency contains the implementation.
The local `staking.py` only preserves imports used by older starter code; new
applications can import these names directly from `bitcoinstratigraphy_agent_yield`.
The SDK preserves its bounded transport, payment limits and independently pinned
Ed25519 receipt verification.

## What the armor protects

| Protection | Behavior |
| --- | --- |
| Session circuit breaker | `max_spend_sats=1000`, including reserved routing fees |
| Per-invoice principal limit | 990 sats, leaving a 10-sat routing-fee reserve |
| Durable total authorization | 1,000 sats across runs using the same private SQLite ledger |
| Wallet fee ceiling | LND is instructed to reject routes costing more than 10 sats |
| Payload provenance | Exact response bytes must verify against your pinned Ed25519 key |
| Tool exposure | One narrow digest tool plus an optional read-only escrow tool; never wallet operations |

The session limit resets when a new SDK client starts; the durable authorization
does not. Reservations can reduce available capacity before a payment is
confirmed. The displayed session balance is **not your Lightning wallet balance**.
OpenAI fees are separate and are **not** covered by the sats circuit breaker.

The 21% mechanism applies to eligible SDK-observed paid calls, not idle wallet
funds or guaranteed investment returns. A free/cached call may show zero cost
and no new yield. A pending claim is not settled income; receiving liquidity
and server policy still matter. Do not count a claim as received until it is
reported settled.

Ed25519 verification establishes server origin and byte integrity. It does not
prove factual accuracy, freshness, Bitcoin anchoring, or correctness of the
agent's later interpretation. The latest indexed digest is not necessarily the
live chain tip and its record hash is not a per-record Bitcoin inclusion proof.

## If execution stops

- **Missing key/configuration:** fill every required `.env` field and check local
  certificate and public-key paths. Relative paths resolve inside this directory.
- **Signature rejection:** confirm the independently trusted pin and that the
  server has deployed payload-signing support. Never disable verification.
- **Budget exhausted:** inspect your authorization and ledger before approving
  more spending. The demo deliberately does not silently increase its limits.
- **Wallet timeout or uncertain payment:** stop and inspect the payment in LND.
  Do not blindly rerun, delete `.agent-yield-state`, or change its path to bypass
  the reservation. Those reservations prevent duplicate spending.
- **Yield recovery needed:** retain the ledger and use the SDK's
  `recover_claim(payment_hash)` only after inspecting that specific claim privately.

No API changes, core protocol edits, production credentials, or automatic
deployment are needed to use this template.

## Check the template without spending

```sh
python -m unittest -v test_starter.py test_staking.py
```

The offline suite uses the actual LangChain graph and SDK with synthetic signed
responses and mocked model/wallet transports. It checks signature tampering,
receipt redaction, the spending cap, routing fees, and uncertain payments.
It also verifies NIP-98 signatures against the exact HTTP bytes, mode headers
through real SDK payment retries, default withdrawals, suppression of competing
claims in staking mode, and fail-closed read-only escrow lookup.
No OpenAI key, real wallet, or network payment is needed for these checks.
