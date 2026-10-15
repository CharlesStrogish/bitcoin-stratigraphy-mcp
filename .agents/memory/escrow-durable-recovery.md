---
name: Escrow durable recovery
description: Historical mainnet baseline and durability/trust boundaries for the Live REST Escrow Oracle.
---

The public verified settlement toll total must preserve the user's historical
24-sat mainnet genesis exactly once, plus future server-confirmed settlement
tolls. Do not count REST access fees, unpaid execution commitments, or repeated
receipt reads.

**Why:** The user requires the cumulative counter and settled receipts to survive
container restarts, autoscale sleep and Republish, rather than reset with a browser
session or container-local filesystem.

**How to apply:** Keep the durable ledger authoritative. A container-local SQLite
workspace is disposable; recovery and cross-replica serialization must use the
database, and a successful response must wait for its durable commit. Storage
failures must be explicit, not an empty ledger or a zero counter. Startup
recovery gates every /api/v1/escrow/* route (wait, else 503 + Retry-After)
instead of blocking the whole server from listening; a failed recovery retries
in the background rather than crashing the process.

Preserve and publicly return the user's complete historical genesis export
exactly, including create_response, settle_response and the nested
article_12_receipt. The user explicitly requested returning the already-released
settlement preimage as part of that export. Preserve original timestamps and
recorded wallet confirmation; do not add qualification fields to the JSON.

**Why:** The user supplied the complete export after the initial metadata-only
baseline and requested exact preservation before Republish.

**How to apply:** Keep that receipt queryable without inventing missing fields.
The export includes a single-leaf hash/root and an empty audit path, but not raw
task/trace/result leaf bytes. Do not append a synthetic genesis leaf to the
execution tree or imply a fresh wallet/Bitcoin confirmation. Existing
legacy files can only be adopted while they still exist; an older deployment's
lost container-local history cannot be recovered merely by republishing.
