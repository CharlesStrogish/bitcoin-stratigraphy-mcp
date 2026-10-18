---
name: Agent ID attribution
description: How self-declared and NIP-98 authenticated agent_id attribution for EU AI Act Article 12 is bound, enforced, stored and committed, and the rollout constraints around it.
---

There are two attribution modes. Both are HMAC-bound into the L402 macaroon as
the exact caveat `agent_id = <id>` and committed into a 128-byte escrow Merkle
leaf: task, trace hash, result hash, then SHA-256 of compact key-sorted JSON.
Unattributed settlements keep the original 96-byte leaf.

- Self-declared (X-Agent-Id header or body `agent_id`): digest of
  `{"agent_id":"<id>"}`, `is_authenticated` false. Never describe it as
  verified identity.
- NIP-98 authenticated (`Authorization: Nostr` at challenge time, or
  `X-Nostr-Authorization` next to an L402 credential): the verified signer
  pubkey becomes agent_id, plus the caveat `agent_authentication = nip98`.
  Digest of `{"agent_authentication":"nip98","agent_id":"<pubkey>"}`,
  `is_authenticated` true. The user required that standard HTTP clients
  without NIP-98 (LangChain etc.) keep working via the self-declared mode.

Rules:
- Invalid NIP-98 events get 401 before any invoice. An authenticated credential
  requires a fresh event from the same pubkey on every use (401 if missing,
  403 for another signer). A verified signer counts as the declaration, so it
  is refused (403) against an unbound credential, like any late declaration.
- The payload tag hashes the captured raw body; tests without raw-body capture
  fall back to `JSON.stringify(req.body)`, which must match what the client sent.
- Events can be replayed within the 60-second freshness window; there is no
  nonce store. The receipt records the server's verification, not the event.
- This is separate from the discounted-pass pubkey binding
  (agent-bound-l402-identity.md).
- A holder may append exactly one agent caveat to an unbound credential
  (delegation to a sub-agent). A second agent caveat invalidates the credential.
- `/api/v1/cost` creates no invoice, so it does not bind agents.
- Settlements are rows in a per-settlement Postgres table, written inside the
  same row-locked transaction before COMMIT. Test fixtures must delete
  settlement rows before their ledger row because of the foreign key.
- Test gotcha: identical challenges at a fixed `now` produce identical
  macaroons, so a re-issued credential shares an already consumed usage scope.

Schema rollout follows the replit.md drizzle push gotcha.

Rollback hazards: once 128-byte leaves exist, builds without attribution fail
closed (503) on escrow receipts; once authenticated leaves exist, builds
without the NIP-98 mode return 422 for those receipts.

**Why:** The user required Article 12 attribution of the requesting sub-agent
in the macaroon, the Postgres ledger and the Merkle receipt, then asked for the
NIP-98 dual mode (October 2026).

**How to apply:** Any change to the leaf layout, the caveat grammar or the
settlement table must keep the Python engine, the Node bridge validation and
the receipt verifier in lockstep.
