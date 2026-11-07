# Isolated A2A clearing scaffold

The production host registers two additional tools at the existing `/mcp` POST
endpoint: `clearing.create_contract` and `clearing.settle_contract`. Hosts and
tests using `registerMcpRoute` opt in with its `clearing` store option. The
production application supplies a PostgreSQL-backed `ClearingContracts` store.

The original 16 priced tool definitions and handlers, the `payment.get_escrow`
definition and handler, and their signed 17-tool integrity manifest remain
unchanged. The clearing catalog is a separate extension, appended at discovery
time; it is **not covered by that core tool-description manifest**. Clearing
does not participate in Genesis Grants, yield staking, royalty allocation,
prepaid data-tool quotas, async tasks, pipelines, or the Python SDK release.

## Funding contract creation

`clearing.create_contract` takes exactly:

```json
{
  "worker_pubkey": "<Nostr x-only public key>",
  "task_hash": "<64 lowercase hex characters>",
  "amount_sats": 123
}
```

The buyer is the verified NIP-98 signer, never an argument or self-declared
header. NIP-98 must sign the exact POST URL and raw JSON request bytes. Both
`Authorization: Nostr ...` and `X-Nostr-Authorization: Nostr ...` use the existing
signature validator. Known revoked identities are refused.

The store inserts a `pending` intent before requesting a BTC Lightning invoice.
Only the new `clearing_contracts` table in the existing PostgreSQL database is
used; no legacy escrow or staking rows are read or modified. The additive
schema is registered with the database package and bootstrapped lazily on use.
Unavailability or missing DDL permissions produces a failure, never memory-only
storage. There is no separate SQLite contract store.

The result includes `escrow_id`, `invoice`, `macaroon`, `payment_hash`,
`amount_sats`, `expires_at`, `status`, `funding_verified: false`, and
`settlement_available: false`. These funding macaroons use a domain-separated
root key and an exact clearing RPC caveat; they cannot purchase core data tools.
An invoice is **not proof of payment or locked funds**.

For retry idempotency, preserve the complete JSON body, including the JSON-RPC
request ID, and sign it freshly. Concurrent exact-request retries create only
one invoice. An ambiguous provider/SQL failure retains the pending reservation
and refuses automatic invoice reissuance. An expired invoice is not refreshed
automatically. Operators must reconcile these reservations before any future
funding/recovery integration; this scaffold includes no automatic recovery,
refund, withdrawal, or payout.

## Settlement is deliberately unavailable

`clearing.settle_contract` takes exactly `escrow_id` and `execution_trace` (a
nonempty UTF-8 string of at most 65,536 characters). It validates fresh NIP-98
authentication, reads the PostgreSQL contract, and compares the authenticated
caller to the stored worker. Missing and foreign contracts both produce the
same authorization refusal.

The authenticated worker receives HTTP 503 with the JSON-RPC error
`CLEARING_EXECUTION_VERIFIER_UNAVAILABLE`. **No contract is marked settled,
no payment is sent, and no ZK-Indemnity Receipt is issued.**

This is the explicitly selected fail-closed scaffold, not working trustless
execution settlement. The existing telemetry and drift Groth16 circuits are
not execution verifiers. A `verified` flag, trace hash, or proof from an arbitrary
caller-supplied verification key is not accepted.

**Do not fund this scaffold.** Before enabling settlement, a separate release
must introduce a purpose-built execution circuit, independently pinned
verification key, documented task-hash/public-signal binding, verified exact
contract funding, atomic/replay-safe settlement, and authenticated receipts.
Lightning custody and worker payout policy must also be specified explicitly.

## Verification

The API test runner includes `src/routes/clearing.test.ts`. Tests use actual
PostgreSQL rows owned by random test identities, real Schnorr NIP-98 signatures,
and an exclusively mocked invoice provider. They never send mainnet payments.
Tests cover catalog isolation, core pass-through, durable creation, concurrent
invoice idempotency, identity forgery/body/URL/freshness failures, worker
authorization, fail-closed settlement, and uncertain provider outcomes.
