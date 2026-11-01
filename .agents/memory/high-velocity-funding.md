---
name: High-Velocity funding scope
description: Why Whale Protocol funding buys fixed-price, tool-scoped request quotas rather than a transferable wallet balance.
---

Whale Protocol pre-funding purchases a shared quota for one fixed-base-price
tool or route, not general-purpose credit across differently priced products.
Funding and subsequent paid requests are surge immune. Exact-toll and
variable-priced products must not silently enter this path.

**Why:** The user requested optional prepaid execution without breaking
single-use payments, changing the private yield schema, or changing the
canonical tool count. Arbitrary cross-product reuse could underfund expensive
requests. Ordinary macaroon holders can append caveats, so a privilege-bearing
pricing mode needs issuer-only proof rather than trusting an appended flag.

**How to apply:** Preserve issuer authentication of bulk pricing, every
inherited shared quota, revocation, expiry and product binding on each use.
Cache settlement evidence, never remaining authorization. Count the whole
confirmed invoice once for revenue and its conditional 21% simulated yield;
additional prepaid calls must not accrue it again. Real outbound payment
semantics remain separate.
