# Stratigraphic Proof-of-Execution Escrow Oracle

This isolated Python service uses the existing enterprise SDK Merkle accumulator.
It does not change MCP tools, HTTP routes, the simulator, or existing tree math.

```python
from services.escrow_db import EscrowStore
from services.escrow_engine import EscrowEngine, configure_engine

engine = EscrowEngine(
    EscrowStore(".data/escrow/escrow.sqlite3"),
    strata_block_provider=trusted_current_strata_height,
)
configure_engine(engine)
contract = engine.create_l402_escrow(buyer_pubkey, worker_pubkey, task_hash, 1000)
settlement = engine.verify_execution_and_settle(
    contract["escrow_id"], execution_trace, result_payload
)
# settlement["preimage"]: private release to the authorized settlement operator.
# settlement["receipt"]: shareable execution commitment.
```

Run in an environment where the existing enterprise SDK is installed. In this
checkout, `PYTHONPATH=sdk/python:. python -m unittest services.test_escrow` needs
no new dependencies.

## Persistence and concurrency

Each connection uses WAL, a 5000 ms busy timeout, and synchronous NORMAL.
`BEGIN IMMEDIATE` serializes writers across threads/processes. Contract settlement
and its leaf/receipt commit atomically. Leaves are replayed through the existing
accumulator, so restarts preserve indexes and roots. Replay costs O(n) per
settlement; the default bounded tree permits 10,000 leaves, then fails without
releasing a secret. There is no automatic rotation that discards previous proofs.
Receipts describe the tree **at settlement**, not its future growing root.

SQLite NORMAL may lose recent committed transactions after power loss; use a
properly backed-up custody volume and understand that durability tradeoff.

## Security and financial boundaries

- Database files are owner-only (0600), with a private parent directory (0700);
  permissive existing files/directories are rejected. The database and WAL contain
  **plaintext secrets**. Permissions are not encryption or an air gap. Deploy on
  an isolated encrypted custody volume; do not expose these modules to untrusted
  workers or add the database to source control.
- Creation reserves a fixed 21-sat toll in the contract ledger. `amount_sats` is
  worker consideration; total accounting reservation is `amount_sats + 21`.
  No invoice issuance, funding verification, funds transfer, or toll collection
  occurs. LOCKED is local contract state, **not evidence of a funded escrow**.
- An authorized operator must independently authenticate the worker, verify
  funding and task acceptance, and validate submitted execution before calling
  settlement. Merely hashing a trace/result cannot establish task correctness.
- The height provider must return a real independently sourced strata height.
  Recording that height does not itself anchor the root to Bitcoin.
- Preimages are excluded from creation responses, metadata reads, and receipts.
  Settlement releases one only after successful commit. Repeat settlement is
  rejected. An interrupted response after commit requires secure operator
  recovery from storage; never pay again automatically.

## Receipt interpretation

The JSON receipt has `escrow_id`, `leaf_index`, `audit_path`, `merkle_root`,
UTC `timestamp`, and supplementary tree size, leaf hash, and strata height.
It supports EU AI Act Article 12 logging/evidence workflows; there is no universal
Article 12 JSON receipt standard and this output is **not legal certification**.
It is neither a signed receipt nor a Bitcoin inclusion proof.

The raw leaf is `task_hash_bytes || SHA256(trace_utf8) || SHA256(result_utf8)`.
The existing accumulator applies RFC 6962's `0x00` leaf prefix exactly once.
Verify membership using the SDK's existing `verify_merkle_inclusion` with that
raw data, the receipt's tree size, and its hex-decoded sibling path/root.

## REST mount

The existing Express server mounts `/api/v1/escrow/create`, `/settle`, and
`/receipt/:escrow_id` through `routers/escrow_api.py` using a bounded, staged
Python worker. No separate Python web server is started. The worker receives
no wallet, payment, session, or operator secrets in its environment.

All three resources require an existing L402 access proof **and**
`X-Escrow-Operator-Token` (the configured operator secret). Each access challenge
costs 21 sats, separately from the contract's 21-sat toll reservation and task
consideration. These are operator endpoints: never distribute the operator
secret to untrusted workers or browser users. Standard token-based CORS applies.
Invalid request fields return 400 before payment processing. For valid inputs,
unpaid requests receive 402 with the standard L402 WWW-Authenticate header;
paid callers lacking operator authorization receive 403.

REST settlement reads the current Bitcoin tip using the existing tip provider
and records its height; this observation is not consensus validation or anchoring.
Unknown contracts return 404 before tip lookup. Settled or otherwise non-LOCKED
contracts return 422. Pending receipt lookups return 404. Provider/custody failures
return 503 without exposing exception details or secrets.

Receipt retrieval validates the stored inclusion path and returns JSON-LD with
trace/result hashes for independent membership verification; no preimage is
included. OpenAPI's `Autonomous Escrow` tag documents these three routes. The
15-tool MCP catalog and its definitions are untouched.

The SQLite file stays outside `dist/` under the API process's private `.data`
directory. Durable production custody/backup remains an operator deployment
responsibility; an ephemeral runtime filesystem is not a persistent custody
volume. Lost settlement responses must not trigger automatic payment or replay.
