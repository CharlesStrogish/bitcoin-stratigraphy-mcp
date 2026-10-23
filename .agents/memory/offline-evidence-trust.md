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
snapshots establish registry state only at the signed capture time. Their
15-minute freshness window does not promise there will be no intervening
revocation. An omitted snapshot must remain explicitly "not checked"; a stale,
untrusted, malformed or revoked-agent snapshot must not silently downgrade into
a receipt-only pass.

Retain independently distributed current and historical issuer pins for
receipt-key rotation. Never auto-enroll keys supplied with the evidence.
Receipt/CRL rotation must not implicitly rotate the MCP integrity and webhook
identity.

**Why:** Enterprise offline audits require both retained historical evidence
and a bounded, explicit registry-time finding. These are not live authorization
or automatic trust in a new issuer.

**How to apply:** Preserve domain-separated signatures and a distinct CRL check
in the UI. Keep historical receipts inspectable without requiring a fresh CRL.
