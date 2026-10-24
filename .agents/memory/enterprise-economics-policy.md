---
name: Enterprise economics and annual exemption policy
description: User-authorized kickback accounting, annual licensing trigger and truthful audit-receipt positioning.
---

The user authorized a ledger-only 5% Autonomous Routing Kickback on an agent's
L402 invoice, with optional LNURL/Lightning-address destinations. Do not send
automatic payouts as part of this feature.

An automatic Tier II exemption requires $250,000 of new confirmed qualifying
volume at current BTC/USD. The user explicitly chose an annual exemption,
strict signed `exp`, and an exact printed Expiry Date **365 days from unlock**.
New qualifying spend is required for renewal; consumed historical payments
must not turn into a perpetual license. New confirmed volume may reserve the
next renewal, but must not silently extend the current token before expiry.

After expiry without qualifying renewal, drop the active commercial caveat and
report high-risk AGPLv3/no-active-exemption status in subsequent request logs.
Do not infer legal obligations for independent weights or unrelated software.

**Why:** The user explicitly required expiry enforcement and return to a
non-commercial licensing status, rather than a permanent exemption. Repeated
payment proofs must not buy additional license years.

**How to apply:** Bind buyers to fresh NIP-98 authentication, not a bare public
key header. Count verified settled invoices exactly once; unfunded invoices,
self-declared reservations and later callers must not gain another buyer's
spend. Keep financial and license changes durable before returning success.

Challenge caches must bind the license generation as well as buyer and payout
identity. Otherwise adding active-license metadata to a cached old invoice
changes its macaroon signature and can create a fresh per-token request budget
for the same payment.

The user requested strict backend nomenclature: **Cryptographic Audit Receipt**
and **State-Anchored Provenance**, with no hallucination-free or legal-indemnity
guarantees. They also require this literal public positioning sentence:

> Provides corporate risk teams with an unforgeable cryptographic audit trail, mathematically proving that an autonomous agent based its execution on state-anchored thermodynamic data.

**Why:** The user requested the exact sentence in public documentation while
accepting accurate descriptions of signed commitments. The signature cannot
actually establish causal agent use or data truth.

**How to apply:** Preserve the requested quotation with adjacent technical
limits. Report signed submitted-data commitments separately from independently
verified Bitcoin anchoring, actual agent behavior and legal compliance.
