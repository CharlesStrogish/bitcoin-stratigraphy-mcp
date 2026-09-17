---
name: Nostr payload attestation cache
description: Integrity and availability rules for signing repeated API payloads with Nostr events.
---

Strip any prior top-level attestation, JSON-detach the unsigned payload, and sign exactly the detached content.

**Why:** Re-attestation and shared nested references can make the delivered object differ from the event content even when the Nostr signature itself verifies.

**How to apply:** Consumers must be able to remove the current attestation and reconstruct the exact signed content. Test nested mutation and re-attestation explicitly.

Cache expensive signatures by serialized unsigned content, not object identity, and keep transport receipts computed over the final attested response bytes.

**Why:** Per-record synchronous Schnorr signing can block the event loop under repeated full-range requests, while identity caches become stale when mutable objects change.

**How to apply:** Reuse signatures only for byte-identical unsigned payloads. Changed content gets a new event; refreshed receipts remain independent and cover the transmitted body.