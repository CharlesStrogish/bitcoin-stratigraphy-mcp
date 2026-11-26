---
name: A2A discovery trust
description: Honest custom MCP binding, shared signing identity and isolation from legacy signature formats.
---

The A2A card describes the existing MCP interface through its custom transport
URI. Do not claim native A2A JSON-RPC, gRPC, HTTP+JSON messaging, streaming,
push notifications, or an extended card without implementing those services.

**Why:** The user explicitly requires zero false production capability claims.

**How to apply:** Treat this card as signed discovery metadata, not permission to
add or relabel MCP execution endpoints.

Bind the card to the existing pinned MCP integrity signing identity, not an
independently configured Article 12 issuer. Keep its JCS/detached-JWS format
separate from all existing receipt, revocation, waiver and manifest signatures.

**Why:** The user requires unified domain trust and byte-for-byte preservation of
existing signature contracts and keys. Replacing old canonicalization with JCS
would invalidate historical verification.

**How to apply:** Reuse the already-loaded integrity key without new key or
secret creation. Compare public key identifiers and preserve independent client
pins; publishing a JWKS or a `jku` does not establish trust by itself.
