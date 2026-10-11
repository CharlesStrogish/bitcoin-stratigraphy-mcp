---
name: SQLite WAL startup contention
description: Cold journal-mode transitions can fail despite the configured busy timeout.
---

Do not assume that a configured busy timeout guarantees successful simultaneous transitions of a cold SQLite database into WAL mode.

**Why:** An isolated concurrent-startup audit intermittently returned `database is locked` at the journal-mode transition despite a 5000ms busy timeout. A subsequent unchanged run passed. Normal WAL transactions passing does not establish reliable cold startup.

**How to apply:** Cover concurrent cold initialization separately from steady-state transactions. Preserve WAL and fail-closed behavior; obtain approval before modifying database initialization during an audit that prohibits core logic changes.
