---
name: Proof lifecycle lookup
description: Semantics for querying prior zk-proof verification, cache, and Nostr attestation state.
---

Index each verification lifecycle under both the SHA-256 proof hash and the proof's snapshot digest. Record pending before work begins, then verified, cached, or invalid after completion; capture NIP-78 attestation count from the exact submitted snapshot.

**Why:** The verifier's cryptographic cache key is intentionally opaque and cannot support user-facing lookup. Binding lifecycle metadata to both public identifiers avoids scanning or weakening the verification cache.

**How to apply:** Keep lifecycle history bounded like the verifier cache. Derive mesh quorum at query time from the current mesh threshold rather than storing a potentially stale boolean.

For explicit ingestion, normalize the submitted coordinate object to the verifier's Groth16/BN128 envelope, require the five public signals in circuit order, and reject a supplied snapshot alias unless it equals the fifth signal. Broadcast NIP-78 only after successful cryptographic verification.

The lifecycle status index is not a proof archive. A separate bounded, process-local payload index can retrieve newly submitted proofs, proofs verified with their exact snapshot, and signed dataset receipts by receipt hash or CID. Historical status-only entries and evicted payloads still cannot be reconstructed from hashes. Submissions without a snapshot must not be presented as independently verifiable against one.

**Why:** Proof verification binds to the complete original payload. Reconstructing a snapshot from telemetry records can change attestation bytes and invalidate the proof; persistent archival was not part of the bounded in-memory lookup.

**How to apply:** For newly consumed datasets, verify the paid REST response's proof against its unmodified data before storing a verified checkpoint. Return not found before payment when no exact payload is retained; do not synthesize proof inputs from status records. If future work needs lookups across restarts, add authenticated durable storage rather than interpreting the status cache as an archive.