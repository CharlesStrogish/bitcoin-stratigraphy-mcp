---
name: Agent ID attribution
description: How the self-declared agent_id for EU AI Act Article 12 is bound, enforced, stored and committed, and the schema-rollout constraints around it.
---

The `agent_id` attribution is self-declared, not authenticated. It is
HMAC-bound into the L402 macaroon as the exact caveat `agent_id = <id>` and
committed into a 128-byte escrow Merkle leaf: task, trace hash, result hash,
then SHA-256 of compact sorted JSON `{"agent_id":"<id>"}`. Unattributed
settlements keep the original 96-byte leaf.

Rules:
- Keep it separate from NIP-98 pubkey binding (see agent-bound-l402-identity.md).
  Never describe agent_id as verified identity.
- A bound credential needs the same declaration (X-Agent-Id header or body
  `agent_id`) on every use. A declaration against an unbound credential is
  refused (403). Malformed or conflicting declarations get 400 before a challenge.
- A holder may append exactly one agent caveat to an unbound credential
  (delegation to a sub-agent). A second agent caveat invalidates the credential.
  Server-side attenuation still accepts delegation caveats only.
- `/api/v1/cost` creates no invoice, so it does not bind agents.
- Settlements are rows in a per-settlement Postgres table, written inside the
  same row-locked transaction before COMMIT. They are not a column on the
  single-row JSONB snapshot. Test fixtures must delete settlement rows before
  their ledger row because of the foreign key.

Schema rollout follows the replit.md drizzle push gotcha.

Rollback hazard: once 128-byte leaves exist, older builds fail closed (503) on
escrow receipts.

**Why:** The user required Article 12 attribution of the requesting sub-agent
in the macaroon, the Postgres ledger and the Merkle receipt (October 2026).

**How to apply:** Any change to the leaf layout, the caveat grammar or the
settlement table must keep the Python engine, the Node bridge validation and
the receipt verifier in lockstep.
