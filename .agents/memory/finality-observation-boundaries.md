---
name: Finality observation boundaries
description: Product and ownership constraints for asynchronous OTS and waiver finality.
---

Finality tracking observes existing execution only: no additional Lightning toll,
quote creation, BIP-84 derivation/index increment, or waiver certificate issuance.
Cancellation stops tracking, not the original notarization, quote or transaction.
Certificate issuance stays behind the original idempotent, confirmation-gated
claim endpoint. Already persisted certificates take precedence over a tracking
snapshot's earlier expiry finding.

**Why:** The user explicitly required strict read-only polling, protection of the
existing payment/claim contracts and zero duplicate issuance.

**How to apply:** Keep tracking dependencies read-only with respect to business
state. Separate receipt issuance from verified Bitcoin anchoring and distinguish
provider outages from confirmation evidence. If tracking fails after paid
execution, preserve the issued receipt rather than encouraging paid re-execution.

An anonymous historical quote UUID is not cryptographic ownership proof. Bind
ownership when an authenticated caller explicitly opts into quote tracking, or
using that caller's matching, still-valid owner-bound checkout handoff. Retain
the established binding independently of the short-lived handoff. Never let a
bare quote/task ID or public TXID bootstrap an ownership claim.

**Why:** Quote creation historically had no authenticated caller binding; claiming
an old UUID as proof would introduce cross-tenant access.

**How to apply:** Reuse the existing fresh NIP-98/dedicated pairing-proof ownership
mechanism. Do not retrofit unauthenticated historical quotes by trusting a
self-declared client identifier.
