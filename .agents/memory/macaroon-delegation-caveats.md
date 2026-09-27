---
name: Macaroon delegation caveats
description: Restriction caveats on delegated L402 tokens must be enforced wherever the token is redeemed.
---

Only accept delegation caveats whose meaning can be enforced at every token-use site. A time bound is checked in signature verification; tool and indexed-target bounds are checked for MCP data calls. For REST and unrelated MCP operations, reject a tool or target caveat rather than silently ignoring it. Inherited path and request-count scopes remain binding.

**Why:** An HMAC-signed caveat is not a restriction if another redemption route ignores it. In particular, a token constrained to certain MCP tools must not authorize a REST endpoint merely because its inherited path also matches.

**How to apply:** Whenever adding an L402 redemption route or a new caveat type, decide how that route evaluates every supported caveat and fail closed if it cannot. Delegation does not widen an existing tool-scoped, single-use parent. Keep revocation scoped to exact presented-token signatures, as documented separately.