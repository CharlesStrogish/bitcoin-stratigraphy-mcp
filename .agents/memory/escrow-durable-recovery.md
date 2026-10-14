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
failures must be explicit, not an empty ledger or a zero counter.

The user-supplied genesis has a valid preimage-to-payment-hash commitment, but
its execution leaf, audit path and original wallet confirmation were not supplied.
Preserve it as operator-supplied historical settlement evidence, not a fabricated
RFC 6962 proof or a newly independently confirmed Lightning payment.

**Why:** A Merkle root alone cannot reconstruct or verify the original proof.

**How to apply:** Keep that receipt queryable without inventing missing fields.
Do not append a synthetic genesis leaf to the original execution tree. Existing
legacy files can only be adopted while they still exist; an older deployment's
lost container-local history cannot be recovered merely by republishing.
