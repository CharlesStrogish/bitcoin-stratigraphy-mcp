---
name: Dynamic pass price binding
description: Security and compatibility rules for dynamically priced L402 subscription passes.
---

Each dynamically issued subscription pass must sign its exact invoice amount into the macaroon, and the payment-challenge cache scope must include that amount. Authorization verifies the issued amount even if the current quote has changed. Legacy macaroons without an amount continue using the static tier base.

**Why:** Verifying against the latest quote can invalidate legitimately paid passes after prices move, while a price-agnostic cache can reuse an invoice created under a different quote.

**How to apply:** Add an optional signed amount caveat to new passes, preserve the original three-caveat verification fallback, and include the quoted amount in subscription challenge keys.

Admission-pressure surcharges apply to newly issued invoices, never retroactively to paid credentials. Fixed-current-amount routes remain outside this surcharge.

**Why:** Paid access must survive load changes, while Treasury toll formulas and exact aggregate pipeline prices must remain authoritative. A requested EV status describes a conditional allocation pool, not verified economic profit or outgoing disbursement.

**How to apply:** Keep both base-product and final-invoice binding. Prevent holders from retrofitting new issuer pricing metadata onto legacy macaroons through ordinary HMAC attenuation. Preserve exact-current-amount checks where explicitly configured.