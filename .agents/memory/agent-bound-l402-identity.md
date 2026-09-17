---
name: Agent-bound L402 identity
description: Security and compatibility rules for NIP-98 reputation discounts on L402 subscription passes.
---

An agent-discounted subscription pass must HMAC-bind the verified Nostr pubkey, reputation tier, and exact discounted amount. Every REST, SSE, and attenuation use must present a fresh matching NIP-98 identity.

**Why:** A discount without request-time identity binding can be transferred to another agent, and a tier label without an amount caveat can drift from the invoice that was actually paid.

**How to apply:** Accept `Authorization: Nostr <base64_event>` for discovery and challenge issuance. When `Authorization` carries L402, require NIP-98 in `X-Nostr-Authorization` for bound passes.

NIP-98 checks must compare the signed absolute URL and uppercase HTTP method exactly, reject future or older-than-60-second events, require empty content, and validate strict tag cardinality. Body-bearing requests must bind the exact raw body SHA-256 in one payload tag.

**Why:** Normalizing attacker-supplied targets, accepting duplicate tags, or hashing reserialized bodies weakens request-target binding and enables replay against a different request.

**How to apply:** Construct one canonical expected URL server-side, preserve raw request bytes, reject malformed event/tag structures as authentication failures, and keep anonymous legacy behavior unchanged.