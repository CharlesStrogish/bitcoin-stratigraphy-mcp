---
name: Dynamic pass price binding
description: Security and compatibility rules for dynamically priced L402 subscription passes.
---

Each dynamically issued subscription pass must sign its exact invoice amount into the macaroon, and the payment-challenge cache scope must include that amount. Authorization verifies the issued amount even if the current quote has changed. Legacy macaroons without an amount continue using the static tier base.

**Why:** Verifying against the latest quote can invalidate legitimately paid passes after prices move, while a price-agnostic cache can reuse an invoice created under a different quote.

**How to apply:** Add an optional signed amount caveat to new passes, preserve the original three-caveat verification fallback, and include the quoted amount in subscription challenge keys.