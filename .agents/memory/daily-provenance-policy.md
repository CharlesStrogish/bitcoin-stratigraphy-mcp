---
name: Daily provenance capture policy
description: Why UTC archive dates must not be manufactured and exact captured bytes must survive retries.
---

Daily provenance capture waits for midnight UTC rather than producing an extra
snapshot at startup. Never backfill an absent historical date using today's live
state. Once a day's JSON is saved, calendar retries must stamp those same bytes.

**Why:** The user requested UTC-dated historical evidence. OpenTimestamps can
establish that exact bytes existed by an anchoring block, but cannot authenticate
a filename's claimed date, reconstruct past telemetry, or prove an exact midnight.
Invented backfills would give agents misleading history despite a valid receipt.

**How to apply:** Keep retrieval read-only, return missing/incomplete archive
states explicitly, and preserve original UTF-8 bytes through downloads and
verification. Distinguish pending calendar acceptance from independently
verified Bitcoin inclusion.

Historical archives must survive server restarts and redeployments. Object
Storage is authoritative; local files are only staging/retry caches, never a
fallback for historical downloads.

**Why:** The user explicitly required removing ephemeral-storage risk. A local
copy cannot establish that an archive remains retrievable after filesystem
replacement, and a silent fallback can hide an unsuccessful cloud upload.

**How to apply:** Persist the JSON before stamping, resume incomplete captures
from their cloud bytes, and distinguish storage outages from missing dates.
Preserve create-only snapshot and initial-proof uploads across concurrent instances.

Pending proofs are replaced in-place after Bitcoin finalization, every six hours
while the API runs. Snapshot JSON remains immutable. Final receipts must retain
verified Bitcoin paths and remove pending calendar-only branches.

**Why:** The user explicitly requested six-hour background upgrades and overwriting
the pending bucket object so downloaded proofs become independent of calendars.
An upgrade alone does not verify Bitcoin inclusion; corroborated public headers
are still weaker than an auditor's fully validating node.

**How to apply:** Condition replacement on the exact object generation read,
validate the daily JSON/proof binding, and leave originals untouched on failure.
Keep the worker's blocking I/O separate from the API event loop and data feed.
Preserve the distinction between a portable finalized receipt and full-node
verification in API status claims.
