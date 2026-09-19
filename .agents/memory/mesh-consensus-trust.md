---
name: Mesh consensus trust
description: Security boundaries for peer snapshot cross-validation and client-side certificate verification.
---

Mesh peers must independently validate the complete snapshot, its fresh source attestation, the originating node identity, and the network domain before signing. Peer identities come from pinned reciprocal configuration; discovery must not create trust.

**Why:** A digest-only signing endpoint becomes a signing oracle, and certificate-supplied membership or thresholds let an attacker manufacture a one-key quorum. Language-native JSON number formatting also produces different hashes across SDKs.

**How to apply:** Use the typed canonical mesh encoding for all snapshot hashes, fail closed when a configured quorum is unavailable, keep isolation explicit, and require SDK callers to supply trusted pubkeys, threshold, network ID, freshness, and isolation policy.