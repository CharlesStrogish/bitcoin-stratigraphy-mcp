---
name: Macaroon delegation caveats
description: Strict first-party caveat grammar for delegated L402 tokens, refusal status codes, and enforcement at every redemption site.
---

Only accept delegation caveats whose meaning can be enforced at every token-use site. Time bounds are checked on every redemption; tool and indexed-target bounds are checked for MCP data calls. For REST and unrelated MCP operations, reject a tool or target caveat rather than silently ignoring it. Inherited path and request-count scopes remain binding.

Canonical delegation caveats are exactly `time < YYYY-MM-DDTHH:MM:SS.sssZ` and `rpc = tool[,tool]` (single spaces, millisecond UTC, unique names, exact matching; a legacy alias is a different name; multiple rpc caveats must all authorize the tool). The verifier refuses any non-canonical spelling, which invalidates the whole credential. Attenuation input may be normalized leniently before signing. Legacy `time_before` and `allowed_tools` caveats are still verified so previously issued tokens keep working.

Refusal semantics: expired delegated `time <` gives 401 and wrong tool gives 403, both before wallet verification. An expired root `valid_until` or an unauthentic credential gets a fresh 402 challenge.

**Why:** The user required hyper-granular least-privilege attenuation (time boxing and tool scoping) with strict parsing. An HMAC-signed caveat is not a restriction if a redemption route ignores it or a lenient parser skips it. Answering an expired delegation with 402 would invite an agent to pay again for access its delegator deliberately ended.

**How to apply:** Whenever adding an L402 redemption route or a new caveat type, decide how that route evaluates every supported caveat and fail closed if it cannot. Delegation does not widen an existing tool-scoped, single-use parent. Keep revocation scoped to exact presented-token signatures, as documented separately. Tests that present many forged credentials must raise the middleware's per-caller challenge limit (default 10 per minute), or refusals turn into 429s.
