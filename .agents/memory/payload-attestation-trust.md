---
name: Payload attestation trust
description: Independent client pins, exact-byte verification and signing identity isolation.
---

Treat server-signed payload provenance separately from payment evidence, source
accuracy, freshness and an AI's subsequent interpretation. Require an independently
trusted key pin; never bootstrap trust from the response being verified.

**Why:** The user requested SDK-enforced payload attestations, building on their
explicit distinction between L402 payment proof and data integrity. A signature
can establish origin and byte integrity, not truth or an AI's future behavior.
The user explicitly approved the Ed25519 implementation and one-byte tamper
rejection test as "perfect."

**How to apply:** Verify the exact received bytes before parsing and receipt
creation. Avoid cross-language JSON canonicalization. Keep the payload signing
identity domain-separated from manifest/envelope/webhook keys so introducing
stronger SDK enforcement cannot silently rotate existing consumer identities.
Coordinate all signing-key rotations with independently distributed client pins.

For the standalone Python starter, preserve the explicit LND REST wallet adapter
and independently provisioned server public-key pin rather than silently
auto-discovering trusted keys.

**Why:** The user explicitly approved both choices as "perfect" for the developer
on-ramp. This approval concerns origin and byte integrity, not factual truth or
guaranteed security of the entire template.

**How to apply:** Keep wallet credentials outside agent prompts and keep pin
provisioning independent of the response being verified when revising the starter.
