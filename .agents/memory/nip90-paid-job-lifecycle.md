---
name: NIP-90 paid job lifecycle
description: Payment and event invariants for the continuously running Nostr data vending machine.
---

NIP-90 jobs must publish `payment-required` before work, confirm the exact incoming invoice by issuing provider, payment hash, amount, and description, then publish `processing`, the signed result at request kind + 1000, and `success`. Put human-readable feedback detail in the third `status` tag value as well as content.

**Why:** HTTP L402 verification assumes the caller supplies a preimage, but relay-driven DVM customers do not make a second authenticated HTTP request. Direct incoming-invoice lookup is required, and loose payment or event binding can fulfill the wrong job.

**How to apply:** For DVM payment or relay changes, keep invoice polling tied to the issuing wallet and exact job metadata, never execute before settlement, never reject already-paid work due to a transient execution limit, and keep duplicate-event memory bounded.