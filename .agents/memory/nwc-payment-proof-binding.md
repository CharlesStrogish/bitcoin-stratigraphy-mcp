---
name: NWC payment proof binding
description: Security constraints for accepting payment-hash and preimage proofs through the Stratigraphy L402 endpoint.
---

An L402 proof based on a payment hash and preimage must also match a settled incoming NWC invoice with the expected product description and minimum amount.

**Why:** Hash/preimage validity alone would let an unrelated, outgoing, or underpaid wallet transaction authorize access to the paid dataset.

**How to apply:** Preserve the direction, settlement, amount, description, hash, and preimage checks whenever the paid endpoint or invoice format changes.