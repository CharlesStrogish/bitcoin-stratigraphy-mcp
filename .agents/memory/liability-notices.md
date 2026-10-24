---
name: Liability notice scope and paid-token compatibility
description: Legal notices are technical records, and changing their signed caveats must not refill paid quotas.
---

Treat liability caveats, HTTP notices and provider-requested agent directives
as communicated contractual terms, not proof of client legal assent,
enforceability, immunity from lawsuits or mathematical alignment. They confer
no additional access privilege or commercial exemption.

**Why:** A server can sign a notice in a bearer token without obtaining a
client's signature on a legal agreement. The requested blanket legal protection
cannot be guaranteed by an HMAC chain or HTTP header.

**How to apply:** Preserve the requested notice text while distinguishing its
technical effect from legal conclusions in documentation and delivery claims.

Do not invalidate previously issued paid tokens retroactively. When new terms
change an issuer's root macaroon signature, separate cached invoice challenges
by the terms generation rather than reminting new quota-bearing roots for the
same historical payment.

**Why:** Existing request budgets are bound to signed token scopes; changing a
root while reusing an old invoice can give the same payment another budget.

**How to apply:** Keep descendants' inherited quotas intact and check cached
challenge isolation whenever changing issuer-added notice caveats.
