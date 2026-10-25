---
name: Online ledger index safety
description: Operational constraints for concurrent ledger indexes and trustworthy catalog validation.
---

Keep online index rollout outside paid request transactions and critical server
startup. Build concurrently through an explicit migration, with bounded waits,
and validate the resulting index before declaring it available. Never repair an
unexpected or invalid index by automatically dropping application tables.

**Why:** The user requires scale improvements without interrupting existing
settlement traffic or changing payment behavior. Concurrent PostgreSQL index
creation cannot run inside a transaction block.

**How to apply:** Use a dedicated migration connection and preserve application
schema ownership. Treat interrupted builds and wrong same-name definitions as
operator-visible failures, not successful idempotent skips.

When comparing PostgreSQL-deparsed index expressions, normalize SQL syntax only
outside quoted string literals. JSONB path names and prefix strings retain their
exact case and spacing.

**Why:** SQL identifiers and JSON keys have different case rules; case-folding or
whitespace-stripping literals can mistake an index on a different JSON key for
the requested one. PostgreSQL also emits explicit text and text-array casts.

**How to apply:** Test both catalog round-tripping against real PostgreSQL and
rejection of same-name indexes using different literal JSON keys.
