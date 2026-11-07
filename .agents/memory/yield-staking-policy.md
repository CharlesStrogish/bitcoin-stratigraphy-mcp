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

For the standalone Python starter, follow the existing MCP POST protocol and
Nostr BIP-340 identity authentication. Keep independently pinned Ed25519 server
receipts separate. Document VIP routing and expanded context as planned rather
than capabilities activated by the current informational feature label.

**Why:** The SDK requirements called for GET, Ed25519 NIP-98 and active VIP
compute. After these differences were explained, the user explicitly chose
“Use existing protocol (recommended).”

**How to apply:** Do not introduce a new GET route or incompatible identity
signature to satisfy the old wording.

Keep native staking behavior in the distributable Python SDK rather than only
in the standalone starter. Preserve the starter's old import names as thin
compatibility imports, not another implementation.

**Why:** When requesting the PyPI release, the user explicitly approved preparing
a native SDK release after the starter-only packaging difference was explained.
A built wheel must actually contain the advertised feature.

**How to apply:** Verify the wheel and rebuilt source distribution independently
of checkout imports before publishing, and make the starter require the released
SDK version. Keep legacy withdrawal defaults and the existing client/adapters.
