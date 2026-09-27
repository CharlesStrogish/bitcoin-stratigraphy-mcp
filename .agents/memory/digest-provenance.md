---
name: Digest provenance
description: Keep compressed stratigraphy summaries honest about indexed heights, source metrics, and proof availability.
---

The digest should describe the latest *indexed dataset entry*, not the live Bitcoin chain tip. Its displayed height and date are deterministic daily-index labels; its target multiplier is a proxy for thermodynamic scaling, not a measured energy field. The record fingerprint is SHA-256 over validated source fields, not a Bitcoin block hash or a ZK proof. The source dataset has no per-record ZK proof.

**Why:** The user chose documented proxies rather than invented source fields. Calling the derived height a live tip, the multiplier energy, or the fingerprint a block/proof hash would give agents false provenance.

**How to apply:** For new digest formats, SDK methods, or discovery metadata, carry these semantics forward. Keep exact compressed text shapes while providing proof availability as separate structured metadata. Change the claim only if real new source data is added and verified.