---
name: NWC payment proof binding
description: Security constraints for accepting payment-hash and preimage proofs through the Stratigraphy L402 endpoint.
---

An L402 proof based on a payment hash and preimage must also match a settled incoming NWC invoice with the exact amount and range-specific product description.

**Why:** Hash/preimage validity alone would let an unrelated, outgoing, underpaid, overpaid, or cheaper-range wallet transaction authorize access to different records.

**How to apply:** Preserve direction, settlement, exact amount, range description, hash, and preimage checks. Day 422 is anchored to 2026-09-09; pricing is one sat per selected day with a five-sat minimum.