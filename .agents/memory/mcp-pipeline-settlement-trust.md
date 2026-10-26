---
name: Pipeline settlement and receipt trust
description: Non-rollback semantics and trustworthy batch evidence for paid MCP pipelines.
---

Treat a cross-tool pipeline as one atomic **payment and admission decision**, not
an atomic transaction spanning external tools. Bind the invoice to the exact
ordered request, consume its quota once, execute sequentially, and fail fast.
Never silently replay a partially completed batch under the same payment.

**Why:** Lightning payments, external notarizations and tool side effects cannot
be rolled back by a PostgreSQL transaction. Calling a partial batch "all-or-
nothing" would mislead agents and auditors, and retrying after a disconnect
could duplicate an effect.

**How to apply:** Preserve a durable in-progress journal and a signed final
receipt containing commitments to the actual resolved inputs and step outputs.
Do not store raw tool arguments or results in shared evidence storage, since
they may contain payment credentials. An offline auditor needs independently
pinned issuer keys and separately archived response bytes to verify those
commitments. Treat an interrupted journal as a recovery investigation, not
permission for automatic re-execution or a claim of legal Article 12 compliance.
