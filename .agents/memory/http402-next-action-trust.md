---
name: HTTP 402 next-action trust
description: Additive challenge guidance must preserve legacy payment contracts and exact challenge-local ownership.
---

Treat `next_action` as additive retry guidance, never a new authorization or
settlement path. Copy only the challenge's already-public invoice, payment hash
and authoritative body macaroon. Preserve every existing header and JSON field.
In particular, a range challenge's first legacy header intentionally carries a
payment hash where the body carries its scoped macaroon.

**Why:** The user requires machine-actionable payment guidance without breaking
existing clients, widening payment rights or disclosing unrelated credentials.

**How to apply:** Bind the retry to the actual redemption endpoint (invoice-only
MCP issuance redeems at `/mcp`; fiat continuity and credit tabs have their own
settlement endpoints). Preserve query selection on ordinary paid retries.
Stateless MCP guidance belongs only in `error.data.next_action`; handshake
guidance remains alongside its legacy challenge fields. Advertise x402 only
after the same response actually receives `PAYMENT-REQUIRED`, never for a credit
tab's whole-debt settlement. Keep purchase recovery and paid verification
independent of presentation changes.
