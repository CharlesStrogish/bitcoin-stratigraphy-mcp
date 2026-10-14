---
name: CoinOS internal payment proofs
description: Safe alternate receipt verification when CoinOS returns an internal-payment UUID rather than a Lightning preimage.
---

Never treat a CoinOS UUID as a Lightning preimage. Distinguish a UUID proof from a lookup hint carried alongside a server-issued, signed payment capability.

## Signed-capability merchant verification

A client holding the issued, scoped macaroon can omit the preimage or supply NWC_LOOKUP or a UUID hint. Verify the exact incoming invoice hash, amount, description, issuer, asset, settled state and settlement time through the merchant's trusted NWC connection. A UUID hint is not evidence of a payer transaction and must not be recorded as such. Do not require consumer payer-wallet access on this path. Retain capability scope, expiry, revocation and atomic usage limits. Bare public payment hashes cannot authorize merchant-only lookup.

**Why:** The user reported live CoinOS and Cash App consumer payments that expose no usable 64-hex preimage. Authorization comes from the issued private capability plus trusted incoming settlement, not from the wallet's reference string.

**How to apply:** Preserve the SHA-256-bound preimage path, and never fall back from an incorrect supplied hex preimage. Pending merchant verification must retain the original invoice rather than prompting another payment. For CoinOS zero/unset node amounts, confirm the exact credited amount against the merchant incoming transaction list and matching invoice. Record merchant verification honestly, without fabricating a preimage.

## Legacy UUID proofs without merchant-lookup mode

A UUID used as the proof itself can authorize an internal payment only after trusted CoinOS views confirm both the exact settled incoming invoice and an outgoing transaction with that UUID, invoice, amount, and payment time. If the payer account cannot be queried, reject the UUID.

**Why:** CoinOS reports an outgoing payment ID for internal transfers; the issuer's incoming invoice may expose the sender's account ID instead, not that payment ID. The Lightning-node amount on an internally credited invoice may be unset, so confirm the credited amount through the issuer's incoming transaction record. Outgoing transactions are account-scoped. An issuer-only lookup cannot bind a UUID from a different payer account to a settled invoice, and a 36-character string cannot satisfy the invoice hash.

**How to apply:** Confirm provider and asset, exact invoice hash, description and amount, bound authorization scope and expiry, and payer-visible outgoing transaction. A same-account transfer can use the issuer connection; different CoinOS accounts require a separately trusted payer connection. Reject unverifiable references instead of inferring settlement from a UUID alone.