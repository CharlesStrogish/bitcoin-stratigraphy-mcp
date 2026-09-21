---
name: Fixed-fee L402 attestations
description: Security invariants for fixed-price HTTP payment middleware and server-issued telemetry attestations.
---

Fixed-fee L402 access grants must be path-bound and single-use, with request parameters validated before payment. A matching preimage hash is necessary but not sufficient: verify settlement amount, description, asset, and issuing provider before consuming the grant.

**Why:** Reusable generic macaroons silently convert a per-request fee into time-window access, and post-payment validation can charge callers for malformed requests.

**How to apply:** Attenuate fixed-fee macaroons with the exact path and a one-request budget, consume that budget atomically after settlement, and reject invalid query/body inputs before invoking payment middleware.

Server-issued cryptographic attestations are valid only when the Nostr signature belongs to the configured service key and the event has the expected NIP-78 kind and commitment tags.

**Why:** Signature validity alone proves that someone signed the payload, not that this service issued it.

**How to apply:** Pin verification to the configured issuer pubkey and check the exact event kind, digest tags, signed commitment, timestamp, block hashes, and Merkle root.