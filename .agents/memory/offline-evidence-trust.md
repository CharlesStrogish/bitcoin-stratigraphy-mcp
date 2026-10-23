---
name: Offline evidence trust
description: Distinguish historical receipt verification from current agent authorization and source-data truth.
---

An offline verification pass is evidence about a signed historical record, not
a current authorization decision. A later agent-key revocation must not silently
invalidate previously authenticated execution evidence. Conversely, a valid
historical receipt must never authorize another request or imply that a key
remains unrevoked.

**Why:** The user requested both a live NIP-98 kill switch and air-gapped CISO
verification. These have different time and trust requirements: an air gap
cannot establish current registry state, and retained Article 12 evidence must
remain independently inspectable after access is withdrawn.

**How to apply:** Require independently pinned issuer and expected agent keys.
Distinguish issuer-attested agent attribution from independent verification of
an original NIP-98 event. Keep local Merkle inclusion, source-data truth,
Bitcoin anchoring and legal compliance as separate findings. Signed revocation
snapshots, if introduced later, need explicit issuance/expiry semantics rather
than pretending to be live status.
