---
name: Mainnet Treasury safety scope
description: User-authorized live NWC withdrawals, frozen schemas and financial recovery invariants.
---

The user authorized live claim-yield withdrawals and then explicitly pivoted
outbound payouts from Coinos REST to Nostr Wallet Connect using NWC_URI.
The existing safety/idempotency state machine and database schemas are frozen.
Preserve inbound L402 gates, the 16 MCP tools, Whale economics and Swarm/21% rules.
Historical mock claims must never be relabeled as mainnet payouts or automatically
paid again. The public payout transparency feed remains a separate contract.

**Why:** The user cannot access the Coinos REST bearer token and explicitly
requires the NWC pivot without schema changes or financial-state redesign.

**How to apply:** Commit exclusive pending reservations before wallet I/O.
Consume balances only with proven settlement and an atomic database transition.
Release on definitive non-payment; retain reservations on ambiguous outcomes,
including local database failures AFTER the wallet call. Reconciliation must
read outgoing wallet evidence, never send a second payment or treat missing
history as failure. Fence retries against stale reconciliation results.
Failed history records for a reused invoice hash can belong to a prior attempt;
without exact attempt binding they must not release the current reservation.

All automated outbound payout tests must mock their NWC client. Never send
real development/test payments to establish that a provider response works.

**Why:** The user requires financial state-machine regressions without spending
mainnet funds during testing.

**How to apply:** Exercise real PostgreSQL transactions with a mocked NWC
client; keep success, definitive failure and timeout/ambiguity cases distinct.

Yield withdrawal announcements use the dedicated NOSTR_SERVER_PRIVKEY (hex or
nsec), not another signing or NWC key. Publish the user's exact Kind 1 note
with the actual settled amount only after a successful mainnet claim response.
Never expose private withdrawal material in public events.

**Why:** The user requires a public Proof-of-Yield oracle while explicitly
prohibiting interference with settled payments or changes to database schemas.

**How to apply:** Defer signing and relay I/O, bound timeouts, catch all failures,
and keep tests on mocked relay connections. Missing keys and relay failures
must never turn a settled withdrawal into an error or release reserved funds.
