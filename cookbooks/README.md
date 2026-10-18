# Python framework cookbooks

## Distributable enterprise suite

The Article 12, B2B settlement, Swarm Flight Recorder and audit-verifier
implementations now ship as a self-contained Python distribution:

```bash
pip install ./sdk/python
```

```python
from bitcoin_stratigraphy_enterprise import SwarmFlightRecorder, Article12NotaryCallback
```

Run this install command from a repository checkout. The package has not yet
been published to PyPI; built wheels can also be installed directly.
See `sdk/python/README.md` for packaging and framework integration.
The original cookbook paths are compatible entry points, including their
mock/patch bindings. No changes are required to older examples.

The dashboard's `/simulator` route demonstrates 50 synthetic agents, real
salted Merkle hashing and selectable inclusion proofs. Its L402/OTS anchor is
an illustration, not a payment or Bitcoin confirmation. Merkle selective
disclosure is not cryptographic zero knowledge.

## Native framework toolkits (Phase 2)

For the 16-tool server and `proof.notarize`, use the standalone
[LangChain MCPAdapter](frameworks/langchain_agent.py) quickstart.
The [LlamaIndex MCP](frameworks/llamaindex_agent.py) source is preserved, but
installation is temporarily unavailable because it requires vulnerable NLTK.
The [framework setup guide](frameworks/README.md) documents separate optional
dependencies, prepaid 100-call L402 Macro-Macaroon headers, local wallet proxies,
safe discovery mode, and explicit agent execution.

Connect Python agents to the remote Bitcoin Stratigraphy server at
**https://bitcoinstratigraphy.com/mcp**. No local server is
needed. MCP uses **Streamable HTTP**, not a legacy `/sse` transport.

The scripts default to **free discovery**. They do not ask an LLM to act, pay an
invoice, or read wallet credentials in that mode. Agent execution is opt-in with
`--run`, a model key, and an explicitly selected payment callback.

## Quickstart: free discovery in under 60 seconds

From the repository root, with Python available:

```sh
python -m pip install "httpx==0.28.1" "langchain-mcp-adapters==0.3.2"
python cookbooks/crewai_example.py
python cookbooks/langchain_example.py
python cookbooks/autogen_example.py
```

The CrewAI and AutoGen commands validate the remote 16-tool catalog and fetch
free REST pricing. LangChain discovers real framework tools through
`MultiServerMCPClient`; its optional `--payment-info` flag calls the L402-paid
`payment.get_info` tool and needs a configured payment hook.
No OpenAI key or wallet is required. Each command normally finishes in seconds;
network outages or uncached package downloads can take longer. LangChain has a
55-second overall timeout.

For the standalone HTTPX client only:

```sh
python cookbooks/l402_client.py
```

This calls the free `stratigraphy.list` tool. The default API URL can be changed with
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
uv run --no-sync python cookbooks/langchain_example.py
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

### LangChain + LangGraph: all 16 tools, five namespaces

`langchain_example.py` uses `MultiServerMCPClient` with
`transport="streamable_http"` and a supported `httpx_client_factory`. It
discovers and validates all canonical tools before giving them to a
LangGraph `create_react_agent`:

- **stratigraphy (5):** `list`, `get`, `get_digest`, `get_diff`, `get_range`.
- **proof (7):** `attenuate`, `verify`, `get_by_hash`, `list`, `submit`, `notarize`, `ground`.
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
MCP names on the wire. All 16 tools, including state-changing `proof.submit` and
`mesh.broadcast`, are available in agent mode: enable it only for an authorized
agent. The demo prompt asks for `payment.get_info` pricing, which is an
L402-paid call; configure a payment hook and spending limits before `--run`.

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

## Article 12 automated audit-evidence cookbook

[`article_12_compliance.py`](article_12_compliance.py) implements
`Article12NotaryCallback`, a LangChain `BaseCallbackHandler` with public
`start_run`, `record_event`, and `finish_run` methods for CrewAI-style loops.
It supports **Article 12 record-keeping evidence**, not a legal-compliance
certification. Article 12 applies to high-risk AI systems; your organization must
determine applicability and the required events, oversight, retention, lawful
processing, and access controls.
See [Regulation (EU) 2024/1689, Article 12](https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng).

The callback records completed and failed root runs: UTC timestamps, session and
agent IDs, original inputs, observable tool inputs/outputs and exposed scratchpad
logs, and the final response. It does not obtain hidden model reasoning.
Credential redaction precedes project-defined canonical sorted UTF-8 JSON
serialization and SHA-256 hashing. Supply a domain-specific `redactor` for PII.
Only the digest is submitted to `proof.notarize`; full traces stay local.

Use this workspace's managed Python 3.13 interpreter (the generic shell
`python` may use a different ABI):

```sh
uv run --no-sync python cookbooks/article_12_compliance.py \
  --journal .data/article12/audit_trail.jsonl
uv run --no-sync python -m unittest cookbooks.test_article_12_compliance -v
```

The runnable example uses a synthetic financial assessment, not an actual
financial decision. Without a prepaid pass it deliberately prints the trace
hash and deferred status, **not a fabricated OTS receipt**. To obtain a real
receipt, provision `L402_AUTHORIZATION` through your secret manager as
`L402 <macaroon>:<preimage>` for a prepaid **tool-scoped `proof.notarize`**
100-call Macro-Macaroon. The SDK sends `X-L402-Batch-Size: 100` on every
notarization. It does not buy or renew invoices, and the header alone does not
purchase or authorize 100 calls.

```python
from cookbooks.article_12_compliance import Article12NotaryCallback, MacroNotarizer
import os

with Article12NotaryCallback(
    agent_id="financial-assessment",
    journal_path=".data/article12/audit_trail.jsonl",
    notarizer=MacroNotarizer(authorization=os.getenv("L402_AUTHORIZATION")),
) as audit:
    response = agent.invoke(
        {"input": "Assess the supplied synthetic financial profile"},
        config={"callbacks": [audit], "metadata": {"session_id": "assessment-session"}},
    )
    audit.flush()  # At the audit boundary, not inside the ReAct loop.
    evidence = response["metadata"]["article_12_notarization"]
```

For CrewAI, use the same public lifecycle API around your existing execution
loop; configure its tool/task callbacks to call `record_event`. No CrewAI import
or dependency installation is added by this cookbook:

```python
run_id = audit.start_run(query, agent_id="crew-financial-assessment")
# Within the crew's step/tool callback:
audit.record_event(
    run_id, "crew_step", {"tool": tool_name, "input": tool_input, "output": tool_output}
)
result = crew.kickoff(inputs={"query": query})
response = {"output": result.raw}
audit.finish_run(run_id, response)
audit.flush()
```

Notarization runs on one bounded background worker, so network I/O does not block
the ReAct loop. Response metadata starts as `pending` and is updated in place;
call `flush` or close the context before serializing the final audit receipt.
Nested chain completions and repeated agent/chain finish notifications do not
create duplicate notarizations. Root chain errors are also captured.

`audit_trail.jsonl` uses owner-only permissions, POSIX file locking, fsynced
append-only records, and a checked hash chain. A trace is persisted **before**
it is queued. Queue saturation and missing credentials remain safely replayable;
network failures remain in the journal. Local disk failures raise explicitly.
This is **plaintext local evidence**, not encrypted/WORM storage: use protected
local disks, restricted directories, governed archival, and retention policies.
Hash chaining detects alteration relative to the stored chain; it cannot prove
that a privileged actor has not rewritten or truncated the entire journal.
Runs that crash before the completion callback need separate durable runtime
logging. For long-lived deployments, use bounded per-worker/session shards and
governed archival rather than one ever-growing journal; each append validates
the existing shard. Do not use filesystems whose POSIX locks are unreliable.

Explicit deferred replay uses the same unchanged digests and prepaid batch pass:

```sh
uv run --no-sync python cookbooks/article_12_compliance.py --replay \
  --journal .data/article12/audit_trail.jsonl
```

Timeouts can be ambiguous: the server may already have consumed a paid call.
These records are not silently replayed. After reconciliation, deliberately add
`--retry-uncertain` if another attempt is authorized. Active attempts are protected
by a cooperative lease; a process crash leaves an uncertain attempt for recovery.
Successful records are skipped. No exception messages or payment credentials are
written into fallback status records.

Receipts are structurally parsed with the project's official OpenTimestamps
library, checked against the exact SHA-256 digest, and attached as `otsProofHex`
alongside `hash` in response metadata. `pending_calendar` is **not Bitcoin
confirmation** or a legal compliance finding; upgrade and independently verify
the receipt later. Client UTC timestamps alone are not trusted time.

### Independent audit verification (no MCP or L402)

Run [`audit_verifier.py`](audit_verifier.py) against the original JSONL journal
after the callback has flushed. It reads the trace and status records by
`trace_id`, checks the append-only hash chain and exact canonical SHA-256 trace
digest, parses real detached OTS receipts, and upgrades pending commitments
using the official Python OpenTimestamps SDK. It never calls our MCP server or
pays an invoice. The original journal is read-only.

```sh
uv run --no-sync python cookbooks/audit_verifier.py audit_trail.jsonl
uv run --no-sync python cookbooks/audit_verifier.py audit_trail.jsonl \
  --markdown .data/article12/report.md \
  --receipt-dir .data/article12/receipts
uv run --no-sync python -m unittest cookbooks.test_audit_verifier -v
```

The optional receipt directory stores owner-only upgraded `.ots` files keyed
by trace digest. Future runs can recheck these saved upgrades even if the
original calendar is unavailable. Never discard the journal in favor of
receipts alone: receipt bytes do not contain the execution trace.

The default verification method checks an OTS Merkle path against a
proof-of-work-valid Bitcoin header and requires **matching block hashes and
headers from both** Blockstream and mempool.space public mainnet explorers.
Their agreement is **not** the same as validating the entire chain yourself.
For regulator-grade independent chain validation, configure a fully validating
**mainnet Bitcoin Core node** for the official `ots` CLI, then run:

```sh
uv run --no-sync python cookbooks/audit_verifier.py audit_trail.jsonl \
  --bitcoin-core --markdown .data/article12/report.md
```

The verifier tells you which Bitcoin check it used. Untrusted calendar URLs
and redirects are refused; only official HTTPS OpenTimestamps calendar hosts
are queried, with per-request deadlines and a bounded number of upgrades.
Some legitimate older HTTP-only calendar attestations will stay pending under
that policy. Missing node access, an unavailable explorer, or an already-mined
block that cannot be checked reports **Verification Unavailable**, not
`VERIFIED`. A newly stamped receipt with no Bitcoin attestation reports
**Pending Calendar Confirmation** rather than failure, regardless of age.
`--offline` performs local checks without network access and never claims
Bitcoin verification.

Exit codes are **0** for an intact journal with verified and/or pending
receipts, **1** for tamper evidence or journal corruption, and **2** for
incomplete/unavailable verification (including absent receipts). The report
includes UTC trace timestamps, agent IDs, full SHA-256 digests, and clear
per-trace statuses. Timestamps recorded by the client are not trusted Bitcoin
time. Even a genuinely verified Bitcoin commitment proves only that the
committed trace bytes existed by the block's time; it does not establish
that the producer captured all events, that the agent really did the work,
that no journal entries were omitted, or that Article 12 legal requirements
are satisfied. Protect and archive journals separately from reports and keep
external journal checkpoints to detect truncation or wholesale rewrites.

### Public web verification

The dashboard's `/standard` page publishes the proposed SA-AI specification
and a free interactive verifier. SA-AI is not an officially recognized
standard or legal certification. The static badge indicates self-asserted
adoption only; only a successfully checked receipt gets a Bitcoin-verified result.

`POST /api/audit/verify` accepts `audit_trail.jsonl` bytes with content type
`application/x-ndjson` or `text/plain`, or an `application/json` envelope:

```json
{"trace":{"agent_id":"your-agent","timestamp_utc":"2026-10-06T00:00:00Z","events":[]},"receipt":{"hash":"<trace-sha256>","otsProofHex":"<detached-ots-hex>"}}
```

Use the exact original trace, not the illustrative object above. Receipt
fields may alternatively be provided directly alongside `trace`, but do not
mix both envelope forms. Requests need no payment, authorization, or MCP
access. The endpoint returns per-trace `status`, `label`, full `sha256`, UTC
timestamp, claimed agent, optional `blockHeight`, journal integrity findings,
and verification-method limitations. Missing/unavailable evidence is neither
verified nor assumed tampered. A raw trace cannot establish journal integrity.

The free endpoint limits bodies to 1 MiB, 128 journal records, 32 traces,
64 receipts, 10 submissions per minute per IP, and two concurrent workers.
Worker CPU, memory, calendar calls and wall-clock time are bounded. Uploaded
evidence remains in memory and is never written to a temporary journal, even
when a request is cancelled. No upload is retained; keep the original evidence
under your organization's governance. Submitting still discloses the supplied
trace to the server operator: use the local CLI and your own Bitcoin Core
node instead for confidential or stronger independent audits.

## Bilateral enterprise contract-state settlement (repository cookbook)

`cookbooks/b2b_settlement.py` demonstrates two independent signing agents
negotiating a procurement contract and using the existing paid `proof.notarize`
tool as a neutral contract-state anchoring service. It adds no MCP tools or
Express routes. This is **bilateral agreement**, not Byzantine consensus,
financial escrow, proof of delivery, or legal certification.

```bash
# Safe synthetic demo: no network, wallet, invoice, or credential use.
uv run --no-sync python cookbooks/b2b_settlement.py

# Explicit synthetic demo with a REAL prepaid notary call.
# First provision a proof.notarize-scoped pass via your approved wallet process
# and supply L402_AUTHORIZATION through your secret manager (never a CLI argument).
uv run --no-sync python cookbooks/b2b_settlement.py --production

# Auditor/court verification: local evidence only, no MCP or payments.
uv run --no-sync python cookbooks/b2b_settlement.py \
  --verify settlement_receipt.json --contract original_contract.json
```

The default demonstration ignores any available credentials. If production
mode lacks a prepaid pass, it still prints genuine contract signatures and a
mutually sealed receipt, but marks anchoring **Deferred/Pending Credential**
with no fabricated OTS bytes. A configured adapter sends
`X-L402-Batch-Size: 100` and its prepaid L402 authorization; it never purchases
an invoice. The header does not itself create a prepaid pass or grant 100 calls.
Revocation, expiration, remaining quota and tool scope are enforced by the
unchanged engine. A failed or ambiguous call is not automatically retried.

### Deterministic contract and receipt binding

The strict `saai-b2b-contract/1` payload has these required fields:

| Field | Contract rule |
| --- | --- |
| `contract_id` | Nonempty bounded transaction identifier; production must coordinate it durably |
| `parties` | Distinct `client`/`vendor`, each with `agent_id` and a 32-byte lowercase hex Ed25519 public key |
| `scope` | Description and ordered list of deliverables |
| `sla` | Integer `max_latency_ms` and `availability_basis_points` |
| `pricing` | `USD`/`EUR` cents or `GBP` pence in integer `amount_minor`, plus integer `payment_due_days` |
| `terms` | Ordered strings; every character, including whitespace, is signed |
| `issued_utc`, `expiration_utc` | Canonical `YYYY-MM-DDTHH:MM:SSZ`; expiration follows claimed issuance |
| `nonce` | Fresh 32-byte cryptographic random value encoded as lowercase hex |

Canonical encoding is the existing project definition: sorted JSON keys,
compact separators, UTF-8 without ASCII escaping, and no non-finite numbers.
This schema rejects unknown fields, floats and booleans in integer fields.
JSON indentation/key order are not contractual terms; string contents are
not trimmed or Unicode-normalized.

Each agent signs the canonical payload. The engine digest is SHA-256 of
the complete deterministic **signed package**, including the payload and both
role-specific signatures. Only that digest—not plaintext terms—is sent to
the notary. Both agents then sign the receipt body, binding their public
keys, original signatures, package hash, expiration and exact OTS bytes.
This produces a **tamper-evident** receipt, not an editable hash-only claim.
Never rewrite its OTS field during an upgrade; keep upgraded proof evidence
separately.

For actual corporate integrations, replace ephemeral demo signers with
independently enrolled enterprise key custodians and authenticated proposal
transport. Supply an approval policy to each signing agent; both approvals and
signatures are required before a paid call. Session-local replay guards
prevent repeated quota redemption in one process, including uncertain
outcomes. They are not distributed exactly-once coordination: persist
transaction/nonce reservations and original evidence across restarts.
Do not use demo keys for real corporate authority.

### Offline dispute-resolution limits

```python
from cookbooks.b2b_settlement import verify_contract_settlement

report = verify_contract_settlement(
    original_receipt,
    original_contract,
    expected_party_keys={"client": known_client_key, "vendor": known_vendor_key},
    trusted_headers=auditor_mainnet_headers,
    upgraded_ots_proof_hex=auditor_upgraded_proof_hex,  # optional
)
```

The auditor checks both contract signatures, both receipt seals, and the
OTS digest/Merkle binding. A pending receipt is **not** evidence of Bitcoin
inclusion or before-expiration anchoring. An embedded Bitcoin attestation is
also not enough by itself.

To confirm Bitcoin inclusion offline, independently obtain a header map from
the auditor's fully validating mainnet node or separately trusted validated
chain evidence. The format is height to `{"block_hash":"<64 hex>",
"header_hex":"<160 hex>"}`. Supply it through `trusted_headers` or
`--trusted-headers auditor_headers.json`; never automatically trust a header
map bundled by the contracting parties. Obtain upgrades separately with the
official OTS tools and pass binary evidence using `--upgraded-ots proof.ots`.
Pin independently enrolled public keys using `--party-keys corporate_keys.json`,
whose JSON fields are `client` and `vendor` with their lowercase 64-hex keys.

`bitcoin_inclusion_verified` and `header_timestamp_before_expiration` are
separate findings. `verified_header_time` means a validated commitment's
block timestamp precedes expiration; `after_expiration` is a late anchor,
not a signature mismatch. **Bitcoin timestamps are miner-declared and do
not establish an exact UTC/legal deadline.** An exact legal timing policy
needs separately agreed trusted time evidence and counsel's interpretation.
No verifier can infer real corporate signing authority from a bare key.

Standalone prerequisites are listed in `cookbooks/requirements-b2b.txt`
(Ed25519 via existing `cryptography`, plus the official OTS Python library).
The repository already has these packages installed; no additional package
was introduced for the cookbook.

## Swarm flight recorder: selective trace disclosure

`cookbooks/swarm_flight_recorder.py` captures high-frequency JSON agent traces
locally, builds an ordered RFC 6962-style Merkle tree, and submits **only one
root hash per batch** to the existing `proof.notarize` tool. No tools, schemas,
routes, or B2B/Article 12 cookbook code are changed.

```bash
# Offline, safe 50-agent / 1000-trace synthetic demonstration.
uv run --no-sync python cookbooks/swarm_flight_recorder.py

# Explicit synthetic demo consuming ONE REAL prepaid root-notarization call.
# Supply a proof.notarize-scoped L402_AUTHORIZATION through your secret manager.
uv run --no-sync python cookbooks/swarm_flight_recorder.py --production

# Local auditor verification of one exported JSON disclosure.
uv run --no-sync python cookbooks/swarm_flight_recorder.py \
  --verify selective_disclosure.json --recorder-key <enrolled-public-key>
```

Without `--production`, available credentials are ignored and no network or
wallet is used. Missing credentials yield **Deferred/Pending Credential**;
no OTS evidence is fabricated. The reused prepaid SDK adapter sends
`X-L402-Batch-Size: 100`, never purchases invoices, and never automatically
retries uncertain notarizations. The header does not manufacture a paid pass
or override expiry, scope, revocation, or remaining quota.

```python
import json
from cookbooks.swarm_flight_recorder import SwarmFlightRecorder, verify_inclusion_proof

recorder = SwarmFlightRecorder()  # Pass a prepaid notarizer explicitly for production.
index = recorder.record_trace(
    {
        "agent_id": "procurement-agent",
        "decision_summary": "Vendor approval blocked pending privacy review",
        "tool_call": {"name": "check_vendor_policy", "outcome": "blocked"},
        "context": {"policy_version": "corporate-approved-version"},
    }
)
receipt = recorder.flush_root()
proof = recorder.generate_inclusion_proof(index)
bundle = recorder.export_disclosure(index)
# Use your approved private evidence store, not a public logs bucket.
report = verify_inclusion_proof(
    bundle["trace"],
    proof,
    receipt,
    expected_recorder_key=recorder.public_key,  # Auditor must independently enroll it.
)
```

### Capture and batch lifecycle

- `record_trace`, `append_trace`, and `add_trace` accept JSON dictionaries.
  Use these from LangChain callbacks or CrewAI event/tool wrappers after an
  explicit enterprise allowlist/redaction policy. They are generic capture
  hooks, not automatic framework callback subclasses; they do not intercept
  or execute tools. Do not indiscriminately log secrets, full prompts, or PII.
- Capture order, not agent-claimed timestamps, defines leaf order. Append is
  thread-safe with worst-case O(log n) hash work. Frozen batch notary I/O does
  not block new trace capture. Fifty demo workers each emit twenty events.
- Defaults: 10,000 active leaves, eight retained batches, 64 KiB per trace,
  and a 16 MiB serialized-leaf byte budget across active/retained batches.
  Tree/hash/object overhead is additional bounded memory. Limits reject new
  work explicitly; there is no silent trace eviction or implicit paid flush.
- `flush_root()` swaps the active tree before network I/O. Empty subsequent
  flushes return the last receipt without another call. A first empty batch
  is not submitted. Failed/uncertain results remain sealed as unavailable;
  an interrupted/failed seal leaves a reserved batch requiring manual
  resolution, not a second quota redemption.
- Leaf indices restart at zero per batch. Preserve the receipt's `batch_id`
  and pass it to proof/export methods when querying older retained batches.
  `release_batch(batch_id)` explicitly deletes that batch's in-memory
  evidence and frees its serialized-leaf budget. Export everything needed
  first: released proofs cannot be regenerated.
- Memory is not a durable audit store or distributed exactly-once ledger.
  Production needs authenticated event sources, durable transaction/root
  reservations, private evidence storage, stable corporate signing-key
  custody, and retention/deletion policies. A crash can lose unexported
  traces, salts and proofs.

### Hashing, disclosure and trust

RFC-style leaf hashing is `SHA256(0x00 || canonical_leaf_bytes)`, internal
nodes are `SHA256(0x01 || left || right)`, and empty-tree hashing is
`SHA256(b"")`. Irregular trees split at the largest smaller power of two;
there is **no duplicate-last-leaf padding**.

A leaf preimage is compact sorted-key UTF-8 JSON containing
`schema_version: saai-swarm-leaf/1`, a fresh private 32-byte random `salt`,
and the exact trace dictionary. Salts resist guessing low-entropy
undisclosed traces. The export contains only the chosen trace, its salt,
index/tree size, sibling hashes, and the root receipt. Other trace
plaintext/salts remain local. The recorder signs the whole root receipt
with Ed25519 so OTS bytes and tree metadata are tamper-evident.

**This is selective-disclosure Merkle verification, not a zero-knowledge
proof.** It reveals the selected trace and structural metadata; it does not
prove that every execution was captured, that events were truthful, or
that a bare recorder key represents an authorized corporation.

`merkle_inclusion_verified` and `bitcoin_inclusion_verified` are independent
findings. A deferred/pending receipt can prove membership in its sealed
local root but **cannot prove Bitcoin anchoring**. For offline Bitcoin
confirmation, separately supply `trusted_headers` from the auditor's fully
validating mainnet node or validated chain evidence. CLI format:
`--trusted-headers auditor_headers.json`, mapping heights to
`{"block_hash":"<64 lowercase hex>","header_hex":"<160 lowercase hex>"}`.
Never automatically trust a map supplied by the recorder.

Keep upgraded OTS bytes separate from the original signed receipt and pass
`--upgraded-ots upgraded.ots`. Bitcoin timestamps are miner-declared and
are not exact legal UTC clocks. Offline CLI exits 0 only for independently
confirmed Bitcoin inclusion, 2 for pending/deferred/unavailable evidence,
and 1 for malformed/tampered evidence.

### Tests and Merkle coverage

```bash
uv run --no-sync python -m unittest cookbooks.test_swarm_flight_recorder -q
# Stdlib coverage, no new test dependency:
uv run --no-sync python -m trace --count --missing --summary \
  --coverdir=/tmp/swarm-flight-coverage --module unittest \
  cookbooks.test_swarm_flight_recorder -q
```

The tree tests compare every prefix size 1–128 and every leaf position
against an independent RFC-style recursive reference, test irregular trees,
domain separation, duplicates, invalid indices/hashes, and short/extra/
reordered paths. The Merkle implementation has **100% executable-line
coverage**. Runtime prerequisites are listed separately in
`cookbooks/requirements-swarm-flight-recorder.txt`; both packages were
already installed in this workspace.

## Official framework references

- [CrewAI remote MCP](https://docs.crewai.com/en/mcp/overview).
- [LangChain adapter HTTP client factory](https://reference.langchain.com/python/langchain-mcp-adapters/sessions/StreamableHttpConnection).
- [LangGraph ReAct API](https://reference.langchain.com/python/langgraph/prebuilt/chat_agent_executor/create_react_agent).
- [AutoGen AgentChat tools](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html).
- [AutoGen model clients](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/models.html).