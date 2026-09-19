---
name: Proof lifecycle lookup
description: Semantics for querying prior zk-proof verification, cache, and Nostr attestation state.
---

Index each verification lifecycle under both the SHA-256 proof hash and the proof's snapshot digest. Record pending before work begins, then verified, cached, or invalid after completion; capture NIP-78 attestation count from the exact submitted snapshot.

**Why:** The verifier's cryptographic cache key is intentionally opaque and cannot support user-facing lookup. Binding lifecycle metadata to both public identifiers avoids scanning or weakening the verification cache.

**How to apply:** Keep lifecycle history bounded like the verifier cache. Derive mesh quorum at query time from the current mesh threshold rather than storing a potentially stale boolean.