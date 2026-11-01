---
name: Swarm referral economics and ownership
description: Referral discount, additional private royalties, ownership trust and compatibility boundaries.
---

The Swarm Royalty Matrix applies a 5% buyer discount after the existing
Thermodynamic quote and credits a separate 5% of the confirmed discounted
invoice to its direct referrer. It does not reduce or replace the buyer's
existing conditional 21% allocation. Whale budgets and exact settlement tolls
do not participate. Recursive recruitment means agents share their own keys;
it does not authorize stacking unlimited ancestor commissions on one invoice.

**Why:** The user expressly prohibited changes to the 16 canonical MCP tools,
Whale funding, baseline Thermodynamic pricing and existing 21% yield logic.
Separate additive simulation accounting preserves historical claims.

**How to apply:** Require fresh NIP-98 ownership proof to issue a referral key
and withdraw its owner's royalties. The shareable key is not a withdrawal
credential. Bind owner and discounted pricing into issuer-authenticated invoice
metadata; never trust referral headers on retries or holder-appended caveats.
Credit once per confirmed payment hash, persist before execution, and leave
balances consumed across retries, descendants and workers. Mainnet Treasury
activation supersedes the earlier mock-only withdrawal policy: explicit claims
can pay real Lightning funds under mainnet-treasury-safety.md. Referral discovery
and incoming payment execution must not themselves trigger withdrawals.

Exact discounted millisatoshis are authoritative for both allocations. The
legacy revenue ledger records rounded-up whole sats; do not infer referred
invoice gross from that rounded aggregate.

**Why:** A 250-sat quote becomes 237.5 sats. Rounding the payment to whole sats
would lose the exact 5% discount, while using 238 sats for claims would inflate
the allocations. Fractional-millisatoshi allocations follow integer flooring.

**How to apply:** Preserve signed and durable exact settlement amounts for
referred invoices without changing historical ledger columns or claims.
