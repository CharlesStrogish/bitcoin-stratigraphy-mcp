---
name: Invoice proof-of-work admission
description: Keep compute admission separate from settled authorization, and preserve replay safety when scaling workers.
---

Require compute only when generating a new MCP L402 invoice, including single
tools, macro passes and ordered pipelines. Do not require another proof during
payment verification or redemption of an existing paid credential.

**Why:** A compute deflector must reduce unpaid wallet work without invalidating
already-paid access or replacing the settlement checks. Admission is not payment.

**How to apply:** Keep challenge binding tied to the exact intended request,
price, scope and agent context. Await the atomic PostgreSQL reservation before
the first wallet call; never reuse its admission after an upstream failure.
Invoice-only entry points must reject credential redemption, including route
case and trailing-slash variants, rather than becoming alternate execution URLs.

Use stateless challenge issuance authenticated by the existing shared server
session secret, and shared PostgreSQL single-use reservations. Store only the
solved challenge's hash and expiry; unverified requests must not allocate rows.

**Why:** The user explicitly requires horizontal scaling without reissuing a
challenge on a worker change. Keeping unverified challenge records would create
a new storage-exhaustion vector. A shared signing key without atomic shared
consumption would let one solution create multiple invoices.

**How to apply:** All workers need the same existing session secret and database.
Database admission must fail closed with no wallet call on storage failure.
Delete expired reservations on startup and periodically even while idle; stop
the cleanup worker on shutdown. Keep the three-zero difficulty and 120-second
expiry unchanged. Schema changes go through development and managed Publish,
never startup DDL. Do not reintroduce process-local keys or memory fallbacks.
