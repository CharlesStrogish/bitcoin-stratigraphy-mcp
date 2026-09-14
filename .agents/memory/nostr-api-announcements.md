---
name: Nostr API announcements
description: Protocol boundary between general HTTP API announcements and NIP-89 handler metadata.
---

Use a general Nostr announcement for an HTTP/OpenAPI service that does not consume Nostr events. Do not publish NIP-89 kind 31990 metadata or a `k` tag unless the advertised application genuinely handles that Nostr event kind.

**Why:** NIP-89 `k` tags are capability claims, not general discovery categories. Advertising an HTTP-only L402 endpoint as a kind-5000 handler would mislead clients and imply unsupported NIP-90 behavior.

**How to apply:** Put endpoint and OpenAPI URLs in the announcement content and `r` tags. Before broadcasting, verify the OpenAPI response and a minimal paid-range L402 challenge without redirects.