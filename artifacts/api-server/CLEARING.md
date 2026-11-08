# Isolated A2A clearing settlement

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
`settlement_available`, `execution_scheme`, `verification_key_id`, and
`payout_available: false`. Production enables receipt settlement using the
Genesis key; local development still requires its explicit opt-in.
These funding macaroons use a domain-separated
root key and an exact clearing RPC caveat; they cannot purchase core data tools.
An invoice is **not proof of payment or locked funds**.

For retry idempotency, preserve the complete JSON body, including the JSON-RPC
request ID, and sign it freshly. Concurrent exact-request retries create only
one invoice. An ambiguous provider/SQL failure retains the pending reservation
and refuses automatic invoice reissuance. An expired invoice is not refreshed
automatically. Operators must reconcile these reservations before any future
funding/recovery integration; this scaffold includes no automatic recovery,
refund, withdrawal, or payout.

## Genesis production proof receipt settlement

`clearing.settle_contract` takes exactly `escrow_id` and `execution_trace` (a
nonempty UTF-8 string of at most 65,536 characters). It validates fresh NIP-98
authentication, reads the PostgreSQL contract, and compares the authenticated
caller to the stored worker. Missing and foreign contracts both produce the
same authorization refusal.

`NODE_ENV=production` or hosted `REPLIT_DEPLOYMENT` selects the installed Genesis
key, never the development key. Missing or incorrect production key material
fails closed. `execution_trace` is a JSON string containing `scheme`:
`clearing-poseidon-preimage-genesis-v1`, the Groth16 `proof`, and two canonical
decimal `publicSignals`: the Poseidon task hash and the unsigned UUID value.
The circuit proves preimage knowledge, not arbitrary task completion.

The server checks the original invoice's exact provider, asset, hash, amount
and description through merchant lookup. Unconfirmed or unavailable funding
cannot settle. An atomic conditional PostgreSQL update stores status, proof
digest, time and signed receipt together. Identical replay returns the stored
receipt; conflicting proofs cannot overwrite it.

Production receipts use the `bitcoinstratigraphy/clearing-genesis-receipt/v1`
signing domain followed by a newline, and bind the exact contract, funding,
proof and verification-key fingerprint. They state `development_only: false`,
`payout_executed: false`, and `legal_indemnity_granted: false`.
Local opted-in development retains its distinct key and receipt scheme.

**There is no automated payout or refund; funds remain merchant-controlled.**
The optional worker-signed `payout_invoice` field is still rejected before wallet
I/O. Do not describe a receipt as a payout, arbitrary-execution proof or legal
indemnity. See [Genesis ceremony](../../circuits/MPC_CEREMONY.md) for key paths,
checksums, distribution and the single-operator trust model.

## Verification

The API test runner includes `src/routes/clearing.test.ts`. Tests use actual
PostgreSQL rows owned by random test identities, real Schnorr NIP-98 signatures,
and an exclusively mocked invoice provider. They never send mainnet payments.
Tests cover catalog isolation, core pass-through, durable creation, concurrent
invoice idempotency, identity forgery/body/URL/freshness failures, worker
authorization, fail-closed local defaults, and uncertain provider outcomes.
The separate `node scripts/test-clearing-production.mjs` suite uses actual
Genesis proofs and an isolated PostgreSQL schema to check production settlement,
key separation, funding failures, receipt signatures, concurrent commits,
replay and contract mutations. It never imports or exercises the core tools.
