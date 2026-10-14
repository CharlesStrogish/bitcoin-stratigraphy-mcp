---
name: SQLite WAL startup contention
description: Cold journal-mode transitions can fail despite the configured busy timeout; how the escrow store handles it.
---

Do not assume that a configured busy timeout guarantees successful simultaneous transitions of a cold SQLite database into WAL mode.

**Why:** SQLite skips the busy handler when connections race to convert a rollback-journal database to WAL (deadlock avoidance). The concurrent-migration escrow regression failed about half of isolated runs with `database is locked` at the journal-mode pragma despite a 5000ms busy timeout.

**How to apply:** The escrow store retries only lock contention at the WAL transition, inside the same 5-second window, then re-raises (fail closed). Keep WAL, `busy_timeout=5000` and `synchronous=NORMAL`; do not broaden the retry to other errors or remove it. Cover concurrent cold initialization separately from steady-state transactions, and loop the concurrency test (20+ runs) after touching initialization — one green run proves little. Under an audit brief that prohibits core logic changes, obtain approval before modifying database initialization.
