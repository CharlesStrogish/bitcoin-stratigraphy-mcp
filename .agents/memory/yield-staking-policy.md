---
name: Yield staking payout policy
description: User-approved explicit withdrawal behavior and cross-ledger exclusivity for staking.
---

Preserve explicit authenticated yield withdrawals. Staking must not introduce
automatic outbound Lightning payouts, and the same paid yield must never be
both staked and withdrawn. Do not reinterpret `withdraw` as permission to send
funds automatically.

**Why:** The requested design assumed automatic payouts; after the difference
was explained, the user chose “Keep existing withdrawals (recommended).”
PostgreSQL was selected so staking and existing Treasury reservations can
participate in one transactional coordination scheme rather than independent
SQLite and PostgreSQL commits.

**How to apply:** Preserve this payout policy when extending staking. New
unstaking, transfers, or automatic disbursement behavior needs explicit scope.
Treat staking as a private accounting reservation, not proof of an outgoing
Lightning payment or a compliance certification.
