---
name: Public receipt broadcast trust
description: Privacy and failure boundaries for publishing completed settlement proofs to public relays.
---

Public receipt events must be allowlisted cryptographic summaries, never raw
receipts, arguments, outputs, payment hashes, preimages, capabilities or agent
identities. Publish only after authoritative evidence persistence succeeds;
preserve failed/interrupted execution status rather than implying full success.
Do not label a pipeline's ordered SHA-256 commitment as an RFC 6962 Merkle root.

**Why:** Public relays are outside the application's privacy boundary and data
cannot reliably be recalled. Full internal receipts may contain bearer payment
material, and a valid settlement does not imply every tool step succeeded.

**How to apply:** Keep relay signing, hashing, journaling and publication outside
the response path. Missing keys, storage outages, queue saturation and relay
timeouts must never invalidate paid work. Publication is best-effort evidence
distribution, not payment verification, legal certification or a durable outbox.
Use recorded invoice amounts, including whole-invoice totals for same-tool
passes, rather than recomputing historical charges from current tool prices.
