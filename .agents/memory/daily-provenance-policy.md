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
