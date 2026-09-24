---
name: Mesh consensus trust
description: Security boundaries for peer snapshot cross-validation and client-side certificate verification.
---

Mesh peers must independently validate the complete snapshot, its fresh source attestation, the originating node identity, and the network domain before signing. Peer identities come from pinned reciprocal configuration; discovery must not create trust. Public broadcast triggers may select only locally sourced, freshly signed canonical records, not arbitrary caller-supplied snapshots; do not report a broadcast as successful unless a remote pinned peer acknowledges it, even when quorum policy allows one local signature.

**Why:** A digest-only signing endpoint or an arbitrary-payload broadcast trigger becomes a signing oracle, and certificate-supplied membership or thresholds let an attacker manufacture a one-key quorum. Language-native JSON number formatting also produces different hashes across SDKs. A local-only quorum is not evidence of remote distribution.

**How to apply:** Use the typed canonical mesh encoding for all snapshot hashes, fail closed when a configured quorum is unavailable, keep isolation explicit, and require SDK callers to supply trusted pubkeys, threshold, network ID, freshness, and isolation policy.