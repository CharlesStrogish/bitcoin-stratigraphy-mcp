---
name: Nostr API announcements
description: Protocol boundary between general HTTP API announcements and NIP-89 handler metadata.
---

Use a general Nostr announcement for an HTTP/OpenAPI service that does not consume Nostr events. Do not publish NIP-89 kind 31990 metadata or a `k` tag unless the advertised application genuinely handles that Nostr event kind.

**Why:** NIP-89 `k` tags are capability claims, not general discovery categories. Advertising an HTTP-only L402 endpoint as a kind-5000 handler would mislead clients and imply unsupported NIP-90 behavior.

**How to apply:** Put endpoint and OpenAPI URLs in the announcement content and `r` tags. Before broadcasting, verify the OpenAPI response and a minimal paid-range L402 challenge without redirects.

For a genuine NIP-90 handler, publish Kind 0 and Kind 31990 through the same relay transport used by the job subscription. Record announcement IDs and success timestamps only after at least one relay accepts the event; keep failed attempts and per-relay reachability visible separately.

**Why:** Pre-committing event IDs makes discovery status claim successful publication during relay outages, and separate transports can report availability that does not match the handler's actual relay path.

**How to apply:** Sequence startup announcements before subscribing for jobs, rebroadcast replaceable handler metadata on a bounded timer, catch periodic failures without unhandled rejections, and clean up the timer and transport atomically on startup or shutdown failure.