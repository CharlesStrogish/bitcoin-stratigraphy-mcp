---
name: Macro payment caching
description: Security and efficiency constraints for cached multi-call L402 payment proofs.
---

Allow authentic descendant macaroons to share a positive settlement lookup only when invoice hash, payment proof, issuer, amount, product description, and tool scope match exactly. A cached payment proof is evidence of settlement, not authorization for a new quota.

**Why:** Keying wallet verification only by the final descendant signature needlessly repeats wallet lookups for one paid invoice; treating a settlement cache hit as unrestricted access would bypass delegated restrictions.

**How to apply:** Keep signature/caveat validation distinct from invoice proof caching. Every redemption still checks revocation and atomically consumes every inherited quota. Authorization-cache expiry must honor descendant time_before deadlines, while ancestor quota counters survive until the root token expires.