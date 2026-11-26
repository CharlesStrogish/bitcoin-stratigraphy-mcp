---
name: Waiver confirmation policy
description: Waiver confirmation windows, irreversible cold-storage address allocation, and privacy-preserving readiness.
---

Waiver buyers need a six-hour first-confirmation window and 15 minutes of
miner timestamp grace, not a 30-minute deadline or a wall-clock lower bound
without grace. Extra confirmations may accrue after that window.

**Why:** The user specifically cited real 40-to-60-minute Bitcoin block
intervals and institutional multi-sig approvals; the narrower deadline could
strand legitimate payments.

**How to apply:** Preserve the distinction between first-confirmation time
and claim submission time. Keep pending users on the same quote and payment.

Watch-only cold storage and never-recycled per-quote addresses are mandatory.

**Why:** Public transaction IDs with a shared deposit address allowed one
licensee to race another's payment. Cold-wallet signing material must never
reach the server.

**How to apply:** Treat the highest exposed derivation index as irreversible
external state. Never reset it to make tests or wallet discovery easier.
Database restore procedures must reconcile exposed addresses before receiving
new funds; increase the wallet discovery range rather than reusing addresses.

Cold-storage readiness is informational only and must not change payment
readiness gating. Readiness and startup checks must never derive child keys or
addresses, allocate indices, contact external services, or disclose key material
or derived addresses in responses or logs.

**Why:** The user requires a strictly side-effect-free readiness signal without
exposing cold-storage configuration or changing existing checkout behavior.

**How to apply:** Validate serialized public account material locally, expose
only a boolean, and keep derivation and address allocation confined to checkout.
