---
name: CoinOS internal payment proofs
description: Safe alternate receipt verification when CoinOS returns an internal-payment UUID rather than a Lightning preimage.
---

Never treat a CoinOS UUID as a Lightning preimage. It can authorize an internal payment only after trusted CoinOS views confirm both the exact settled incoming invoice and an outgoing transaction with that UUID, invoice, amount, and payment time. If the payer account cannot be queried, reject the UUID. Keep SHA-256 preimage binding for external Lightning payments.

**Why:** CoinOS reports an outgoing payment ID for internal transfers; the issuer's incoming invoice may expose the sender's account ID instead, not that payment ID. The Lightning-node amount on an internally credited invoice may be unset, so confirm the credited amount through the issuer's incoming transaction record. Outgoing transactions are account-scoped. An issuer-only lookup cannot bind a UUID from a different payer account to a settled invoice, and a 36-character string cannot satisfy the invoice hash.

**How to apply:** Confirm provider and asset, exact invoice hash, description and amount, bound authorization scope and expiry, and payer-visible outgoing transaction. A same-account transfer can use the issuer connection; different CoinOS accounts require a separately trusted payer connection. Reject unverifiable references instead of inferring settlement from a UUID alone.