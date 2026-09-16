---
name: Macaroon revocation scope
description: Security semantics for operator revocation of delegated L402 subscription macaroons.
---

Revocation targets a macaroon's exact final signature. Its parent and sibling tokens remain valid unless separately revoked. Authorization must reject matches before wallet verification and fail closed when the shared revocation index cannot be queried.

**Why:** Exact-token revocation contains a leaked delegation without destroying the paid parent entitlement, while pre-verification lookup prevents revoked credentials from triggering wallet work.

**How to apply:** Store final signature identifiers in shared PostgreSQL, authenticate management calls with a dedicated operator secret, and return 401 for matches or 503 when lookup cannot be completed.