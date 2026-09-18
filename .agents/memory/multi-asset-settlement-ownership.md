---
name: Multi-asset settlement ownership
description: Security invariants for issuing and verifying payments across settlement assets and fallback providers.
---

Every issued payment must remain bound to its settlement asset and exact issuing provider. Subscription credentials carry signed asset and provider caveats. Legacy challenges require caller-bound persisted ownership metadata and must fail closed when it is missing, expired, or mismatched.

**Why:** Searching fallback providers during verification expands the payment trust domain, and retaining issuer metadata only for the shorter challenge-reuse period can reject a valid invoice that is still payable.

**How to apply:** Keep challenge reuse separate from proof-redemption retention. Preserve asset/provider ownership for the full invoice lifetime, route verification only to the issuer, use the same caller identity at issue and redemption, and enforce identical expiry semantics in memory and PostgreSQL stores.