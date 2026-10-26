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
price, scope and agent context. Reserve a solved challenge synchronously before
the first wallet await; never reuse its admission after an upstream failure.
Invoice-only entry points must reject credential redemption, including route
case and trailing-slash variants, rather than becoming alternate execution URLs.

Use bounded replay state and stateless challenge issuance. Process-local
ephemeral signing keys intentionally fail closed when a retry changes workers.

**Why:** Keeping unverified challenge records would give attackers a new memory
exhaustion vector. Sharing only a signing key across workers would let one
solution create multiple invoices unless consumption is also shared atomically.

**How to apply:** For cross-worker reliability, introduce atomic shared,
TTL-bounded proof consumption together with shared challenge authentication.
Never fix retry failures by removing single-use checks or by accepting a token
from another worker without reserving it globally.
