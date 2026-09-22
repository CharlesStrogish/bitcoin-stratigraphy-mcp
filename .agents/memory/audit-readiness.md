---
name: Audit readiness boundaries
description: Distinguish HTTP startup, relay publication, and paid settlement evidence in audits.
---

HTTP readiness does not imply Nostr announcement readiness; allow a bounded wait for missing announcement state, but fail malformed state immediately.

**Why:** Repeated audits immediately after API restart produced false NIP-89 failures while asynchronous relay publication was still running.

**How to apply:** Keep API startup independent of relay latency, and distinguish locally verified signatures, relay acceptance, invoice issuance, and actual paid settlement in audit reports. Never describe challenge-only live checks as completed live payment verification.