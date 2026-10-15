---
name: Audit readiness boundaries
description: Distinguish HTTP startup, relay publication, and paid settlement evidence in audits.
---

Right after a republish, the live domain can route to the new VM before the API listens. On 2026-10-14 the API paths returned a 21-byte text/plain "Internal Server Error" for about 45 seconds, while static frontend files were already served normally.

**Why:** A first live audit landed inside that boot window and briefly looked like a release regression; the deployment logs showed platform healthcheck failures until the API logged "Server listening".

**How to apply:** Before treating live API 500s after a publish as a code failure, check deployment logs for the API's listening line and re-probe. Since the listen-first startup (see api-startup-readiness.md), refused connections should be gone; the "Server listening" line carries portBoundMs and applicationLoadedMs for the boot breakdown.

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