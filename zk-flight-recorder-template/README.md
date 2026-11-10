# ZK Flight Recorder — LangChain Template

An installable Python execution recorder for LangChain agents, using Bitcoin
Stratigraphy's prepaid L402 scanner. It records chain, model, chat and tool
start/end events and execution errors. Runs and parents are correlated by ID.

## Cryptographic Indemnity for EU AI Act Compliance

**This is a positioning concept, not a legal or cryptographic guarantee.**
This template does not provide indemnification, insurance, a compliance
certification, or legal advice. EU AI Act Article 12 concerns automatic event
recording for applicable high-risk systems; a callback plus a paid API is not,
by itself, sufficient to establish compliance. Your legal and compliance teams
must assess applicability, logging completeness, retention, access, oversight
and the deployment as a whole. Contractual indemnity requires a separate,
explicit agreement.

### What the live endpoint actually returns

`POST https://bitcoinstratigraphy.com/api/scanner` currently returns
`article12-heuristic/v1`: keyword-based risk screening, `prompt_sha256` and
`compliance_hash`, with `receipt_type: simulated_zk_receipt`.

**These are SHA-256 commitments, not Groth16 proofs, signed attestations,
Bitcoin timestamps, or proof that an AI execution actually happened.**
Anyone can compute the hashes; checking them detects mismatches with the
submitted bytes but does not authenticate an issuer. The recorder checks both
commitments and retains the exact submitted prompt and response locally.
It cannot turn a hash into a zero-knowledge proof. Existing Groth16
preimage-verification tools prove a different statement and are not substitutes
for arbitrary execution-log proofs.

If real Groth16 evidence is mandatory, set
`FLIGHT_RECORDER_REQUIRE_GROTH16=true`: the recorder fails closed before making
a paid request. A suitable circuit, proving service and independently pinned
verification key are required before that mode can operate.

## Quick start

Requires Python 3.11+ and an already-funded **scanner-scoped** Macaroon.

A `uv.lock` is included for reproducible CI dependency resolution. The simple
pip installation below resolves the compatible range in `pyproject.toml`;
use the lockfile with your CI's uv tooling when exact versions are required.

```bash
python -m pip install .
cp .env.example .env
# Fill .env locally. Never paste real credentials into source, logs or prompts.
# Load only your trusted local configuration:
set -a
. ./.env
set +a
python example.py
```

The example uses `RunnableLambda`, not an external LLM, but its scanner calls
are **live paid calls**. Each callback event consumes one scanner credit.
Nested chains and tools can generate many events. The existing product grants
100 calls for 100,000 sats, valid for 30 days. Other MCP capabilities and
unfunded L402 challenges are not interchangeable with these prepaid credits.
Acquire the credential through the developer portal's Lightning purchase
or a fully configured, operator-funded card bridge.

The bridge's Stripe test charge alone does not fund a Macaroon. Never use an
unsettled challenge token or assume a test credit-card payment transferred fiat.

## Attach to your agent

```python
from flight_recorder import DurableRecorder, langchain_callback

with DurableRecorder.from_env() as recorder:
    callback = langchain_callback(recorder)
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "Your task"}]},
        config={"callbacks": [callback]},
    )
    # For async agents, await agent.ainvoke(..., config={"callbacks": [callback]}).
```

Callbacks run inline and propagate errors. A start-event recording failure
can prevent the agent operation. An end-event failure **cannot undo** an
already-executed tool or external side effect. LangChain can invoke error
callbacks after a callback failure, causing additional recording attempts;
do not interpret those as a transaction rollback.

Streaming tokens are not submitted individually. The final model output is
recorded on `on_llm_end`. This template does not intercept processes or tools
that do not participate in your agent's LangChain callback lifecycle.

## Configuration

| Variable | Required/default | Purpose |
| --- | --- | --- |
| `L402_MACAROON` | Required | Funded prepaid token, without `Macaroon ` prefix |
| `SCANNER_URL` | Canonical HTTPS endpoint | Must be HTTPS `/api/scanner`, no query or redirects |
| `FLIGHT_RECORDER_DB` | `./private/flight-recorder.sqlite3` | Durable local event/receipt journal |
| `FLIGHT_RECORDER_CAPTURE_CONTENT` | `false` | Opt-in to external transmission of redacted inputs/outputs |
| `FLIGHT_RECORDER_REQUIRE_GROTH16` | `false` | Reject current simulated receipt contract if true |

## Privacy and retention

Default logging captures event type, event ID, UTC timestamp, run ID and parent
run ID, **not inputs or outputs**. This is safer but not a full execution trace.
Enable content capture only after reviewing data-processing agreements,
personal-data handling, trade-secret exposure and your retention policy.
The supplied redactor covers common credential keys, authorization strings,
Stripe keys and email addresses; it is not a universal PII detector.
Inject an application-specific `redactor` into `DurableRecorder` as needed.

The token is sent only as an authorization header to the configured HTTPS
endpoint. Redirects are refused. No authorization is written to the journal.
The scanner states that it does not retain prompts and reports; **your
application must retain evidence itself**.

The local SQLite file is created with mode `0600`. Use an encrypted, backed-up
persistent volume and a dedicated service account; secure its parent directory.
Set backup, deletion and retention policies for both the prompts and responses.
The journal is not append-only, independently timestamped, or tamper-proof.
An administrator can rewrite it and recompute the unsigned hashes.

## Failure and recovery

1. A complete event is committed locally as `pending` before submission.
2. The scanner receives `{"prompt": "<exact event JSON>"}` with
   `Authorization: Macaroon <token>`.
3. Both returned commitments are checked against the exact submitted bytes.
4. Successful reports are saved as `recorded`. A failed or ambiguous call is
   saved as `unknown`, and an exception propagates.

No retries or wallet payments happen automatically. The scanner has no
idempotency/retrieval contract for a timed-out scan; resubmitting can consume
another credit. Do not hide failures with synthetic receipts.

Inspect unresolved events using your SQLite tooling:

```sql
SELECT id, state, created_at FROM events WHERE state != 'recorded';
```

Review and reconcile with the operator. If a new paid scan is explicitly
approved, submit the stored `prompt` bytes through `ScannerClient.scan` and
retain the resulting report with a separately documented recovery record.
Do not silently overwrite an ambiguous attempt. Oversized events fail rather
than truncate: split them in your application before recording.

HTTP errors, exhausted credits and expired/revoked tokens fail explicitly.
Timeouts have unknown paid outcomes. SQLite disk errors are fatal; do not run
an unattended agent without storage monitoring.

## Tests and deployment checklist

```bash
python -m unittest discover -s tests -v
```

Tests use synthetic scanner responses and a temporary journal; they neither
spend sats nor call production. Before deploying, run your own staging
LangChain integration with a deliberately budgeted funded token, verify the
callback lifecycle, configure encrypted storage and monitoring, and review
retention, privacy, model/tool side effects and contractual obligations.

The template directory's historical “ZK” name describes the intended future
proof integration, not the evidence returned by the current scanner.
