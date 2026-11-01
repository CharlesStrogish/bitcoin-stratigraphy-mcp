---
name: Mainnet Treasury safety scope
description: User-authorized live Coinos withdrawals, schema exception and financial recovery invariants.
---

The user authorized replacing mock claim-yield withdrawals with live Coinos REST
payouts, and schema changes ONLY for robust payout safety/idempotency tracking.
Preserve inbound L402 gates, the 16 MCP tools, Whale economics and Swarm/21% rules.
Historical mock claims must never be relabeled as mainnet payouts or automatically
paid again. The public payout transparency feed remains a separate contract.

**Why:** The user explicitly superseded the earlier no-schema-change restriction
for the safety tracking needed to move real funds, not for broader redesigns.

**How to apply:** Commit exclusive pending reservations before wallet I/O.
Consume balances only with proven settlement and an atomic database transition.
Release on definitive non-payment; retain reservations on ambiguous outcomes,
including local database failures AFTER the wallet call. Reconciliation must
read outgoing wallet evidence, never send a second payment or treat missing
history as failure. Fence retries against stale reconciliation results.
Failed history records for a reused invoice hash can belong to a prior attempt;
without exact attempt binding they must not release the current reservation.

All automated outbound payout tests must mock their HTTP transport. Never send
real development/test payments to establish that a provider response works.

**Why:** The user requires financial state-machine regressions without spending
mainnet funds during testing.

**How to apply:** Exercise real PostgreSQL transactions with a mocked Coinos
transport; keep success, definitive failure and timeout/ambiguity cases distinct.
