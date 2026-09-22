---
name: NWC self-payment proofs
description: Wallet behavior that prevents secure L402 proof redemption when invoice issuer and payer are the same NWC wallet.
---

Do not use the invoice-issuing NWC wallet to pay its own L402 invoice unless the provider is confirmed to return the original 32-byte Lightning preimage and payment hash. Use a separate payer wallet for operational settlement simulations.

**Why:** This wallet provider reports UUID-shaped identifiers for both fields on same-wallet transfers, even though it marks the transfer settled. Those identifiers cannot satisfy SHA-256 payment proof binding, so the API must reject them.

**How to apply:** Operational scripts should accept a separate payer connection, validate a 64-hex preimage against the challenged hash before redemption, and stop rather than weakening proof verification when the wallet returns provider-local identifiers.