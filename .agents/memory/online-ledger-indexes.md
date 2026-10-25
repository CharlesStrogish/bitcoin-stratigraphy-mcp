---
name: Online ledger index safety
description: Operational constraints for concurrent ledger indexes and trustworthy catalog validation.
---

Keep index initialization outside paid request transactions and critical server
startup. Development builds can run concurrently through an explicit command,
with bounded waits. Managed production schema changes must go through Publish;
its generated SQL can use ordinary, write-blocking index builds. Never repair an
unexpected or invalid index by automatically dropping application tables.

**Why:** The user requires scale improvements without interrupting existing
settlement traffic or changing payment behavior. Concurrent PostgreSQL index
creation cannot run inside a transaction block.

**How to apply:** Use a dedicated development connection and preserve application
schema ownership. Treat interrupted builds and wrong same-name definitions as
operator-visible failures. Inspect the actual publish diff; a successful
concurrent development build does not establish the production rollout behavior.

When comparing PostgreSQL-deparsed index expressions, normalize SQL syntax only
outside quoted string literals. JSONB path names and prefix strings retain their
exact case and spacing.

**Why:** SQL identifiers and JSON keys have different case rules; case-folding or
whitespace-stripping literals can mistake an index on a different JSON key for
the requested one. PostgreSQL also emits explicit text and text-array casts.

**How to apply:** Test both catalog round-tripping against real PostgreSQL and
rejection of same-name indexes using different literal JSON keys.

Use the scalar origin on verification-credit records for indexed upstream
allocation lookups. Avoid the redundant long nested invoice-origin index.

**Why:** Publishing's schema introspection truncated both a text-array path and
its equivalent chained JSON expression, generating invalid `CREATE INDEX` SQL
even though PostgreSQL accepted both development indexes. The authoritative
credit records already retain the same origin as a scalar JSON key.

**How to apply:** Validate the generated development-to-production diff itself,
including parsing it against isolated development fixtures, before retrying a
failed publish. Do not bypass managed migrations with production scripts.
