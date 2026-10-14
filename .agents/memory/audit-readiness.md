---
name: Audit readiness boundaries
description: Distinguish HTTP startup, relay publication, and paid settlement evidence in audits.
---

HTTP readiness does not imply Nostr announcement readiness; allow a bounded wait for missing announcement state, but fail malformed state immediately.

**Why:** Repeated audits immediately after API restart produced false NIP-89 failures while asynchronous relay publication was still running.

**How to apply:** Keep API startup independent of relay latency, and distinguish locally verified signatures, relay acceptance, invoice issuance, and actual paid settlement in audit reports. Never describe challenge-only live checks as completed live payment verification.

For computation that happens after payment, the user requires
`ENDPOINT_READY_AWAITING_L402_SETTLEMENT` with the expected output schema and
Merkle proof standard, not a claim that data is already staged and verified.

**Why:** The user explicitly clarified that connecting agents must know what will
be generated upon payment; a payment challenge does not demonstrate completed
computation or proof verification.

**How to apply:** Preserve this distinction on new paid routes and in agent-facing
previews. Describe OTS format readiness separately from calendar acceptance or
Bitcoin confirmation.