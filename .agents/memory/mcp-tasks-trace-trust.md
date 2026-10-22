---
name: MCP Tasks and trace trust
description: Why polling, remediation payments, bearer handles, and trace-aware commitments must remain distinct from webhook and legacy receipt contracts.
---

The user requested SEP-2663 polling in addition to, not instead of, the existing
v1a push callbacks. Never enumerate tasks. An explicit callback URL takes priority.
Task IDs are secret bearer capabilities; do not log them or publish task lists.
Persist task admission and transitions before acknowledging them. Never replay
charged execution automatically after restart.

**Why:** Swarm clients need both transports without duplicate paid execution or
cross-client disclosure. Corrected input is a new operation requiring the normal
authorization, source/target, revocation, settlement, and quota checks; retaining
payment credentials in durable tasks would bypass their freshness and scope.

**How to apply:** Preserve raw signed requests when processing corrections.
Do not fabricate a tools/call body to authorize a tasks/update request. Keep
remediation single-winner under concurrent updates and cancellation.

Trace context is correlation metadata, never identity. Add it to a new committed
leaf format rather than changing historical leaf bytes or attaching it to a
receipt after hashing. Receipt verification must reject deletion as well as
modification of committed context.

**Why:** Existing receipt proofs must remain independently verifiable, and
unsigned transport metadata must not be presented as committed evidence.

**How to apply:** Preserve legacy unattributed and attributed proof formats.
When changing commitment inputs, update the worker, bridge, schema constraints,
and receipt verifier together. Keep attribution and trace-context domains separate.
