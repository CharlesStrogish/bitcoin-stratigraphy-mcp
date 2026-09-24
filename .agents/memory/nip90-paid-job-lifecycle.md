---
name: NIP-90 paid job lifecycle
description: Payment and event invariants for the continuously running Nostr data vending machine.
---

NIP-90 jobs must publish `payment-required` before work, confirm the exact incoming invoice by issuing provider, payment hash, amount, and description, then publish `processing`, the signed result at request kind + 1000, and `success`. Put human-readable feedback detail in the third `status` tag value as well as content.

**Why:** HTTP L402 verification assumes the caller supplies a preimage, but relay-driven DVM customers do not make a second authenticated HTTP request. Direct incoming-invoice lookup is required, and loose payment or event binding can fulfill the wrong job.

**How to apply:** For DVM payment or relay changes, keep invoice polling tied to the issuing wallet and exact job metadata, never execute before settlement, never reject already-paid work due to a transient execution limit, and keep duplicate-event memory bounded. Public request kinds can attract responses from unrelated providers, so clients must select the provider that issued their payment request and ignore unsolicited errors from others.

The advertised kind-5050 data/verification request uses a fixed 250-sat invoice; older NIP-90 kinds retain their separate configurable fees. The 10-sat discovery tier refers to MCP tool access, not the full DVM job.

**Why:** Existing relay clients may already depend on the older job-kind prices, while the new advertised data/verification request must match its 250-sat claim.

**How to apply:** Keep announcement content explicit about which pricing belongs to MCP versus NIP-90. Never present the relay job invoice as redeemable at the MCP HTTP endpoint; NIP-90 uses its own amount tag and exact-invoice settlement check.