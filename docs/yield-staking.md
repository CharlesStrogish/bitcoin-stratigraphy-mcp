# Yield staking escrow

The original 16 MCP tools keep their existing inputs, outputs, pricing and
execution implementations. `payment.get_escrow` is a separate, free,
authenticated payment utility; `tools/list` now returns 17 tools.

## Stake a confirmed Lightning invoice

1. Obtain an L402 challenge while presenting fresh NIP-98 authentication.
   This binds the issued invoice macaroon to the signing pubkey. Set
   `X-Yield-Mode: stake` to request an ordinary invoice instead of a free
   Genesis Grant or deferred credit-tab call.
2. Pay the exact invoice using your wallet.
3. Retry the same tool request with `Authorization: L402 <macaroon>:<preimage>`,
   `X-Yield-Mode: stake`, and a fresh `X-Nostr-Authorization: Nostr <base64-event>`
   from the same signer. The NIP-98 event must bind the exact public URL,
   HTTP method and request-body hash.
4. The middleware verifies settlement, persists incoming revenue, and commits
   the staking reservation before consuming the tool's request quota.
   The response includes `X-Yield-Mode: stake` after a successful credit.

Bearer-only invoices, another signer's delegated credential, free calls,
unconfirmed invoices and merchant-lookup-only proofs cannot mint stakes.
Anonymous invoices cannot be retrospectively assigned to a signing identity.
Staking applies only to L402 Lightning preimage redemption, not x402, enterprise
credit-tab settlements or free sandbox executions. A `stake` request never
changes the underlying data-tool calculation or waives payment.

Without the header, or with `X-Yield-Mode: withdraw`, the existing
**explicit withdrawal** flow remains unchanged. Neither mode automatically
sends Lightning funds. There is no unstaking or transfer API in this release.
Staking reserves the invoice's entire eligible private 21% yield; it cannot
subsequently be withdrawn through `/api/claim-yield`. Historical claims,
including pending or ambiguous payouts, cannot be staked.

## Authenticated balance lookup

POST `/mcp` with fresh NIP-98 authentication and:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"payment.get_escrow","arguments":{}}}
```

The MCP result's `structuredContent` (and JSON text content) contains:

```json
{
  "pubkey": "<signer-pubkey>",
  "staked_sats": 0,
  "vip_status": false,
  "unlocked_features": ["zero_latency_routing"]
}
```

The lookup accepts no owner parameter and always queries the authenticated
signer's balance. An unknown signer receives a genuine zero balance without a
database write. `vip_status` is true strictly above 10,000 whole sats.
The requested `zero_latency_routing` label is informational; it does not enable
a payment bypass or provide a network-latency guarantee. Responses are
`Cache-Control: no-store`. Batch/pipeline and task execution are not supported
for this private utility.

NIP-98 uses Nostr's secp256k1 Schnorr signatures. It is separate from the
Ed25519 response/Truth Receipt signing identity.

## Durability and accounting

The ledger uses the existing PostgreSQL database, not a separate SQLite file.
`yield_staking_accounts` maps the SHA-256 hash of the decoded signer pubkey to
an exact integer-millisatoshi balance and a generated integer `staked_sats`
column. Fractional sats carry forward; the displayed balance is floored only
when converting the accumulated balance to sats. The per-invoice yield is
`floor(exact_paid_msats * 21 / 100)`, including fractional-sat referred invoices.
The existing independent 5% referral ledger is unchanged.

`yield_staking_receipts` has a unique payment-hash primary key. Receipt binding,
account increment and receipt insertion commit together. All staking and
Treasury withdrawal workers acquire the same transaction-scoped payment-hash
lock. Pending withdrawal reservations remain exclusive during wallet I/O.
Retries and macaroon descendants cannot credit the same invoice twice.
Stake writes fail closed with an explicit error before execution/quota use
if storage is unavailable. A lost commit acknowledgement is safe to retry.

Staking is accounting for confirmed incoming yield, not proof of an outgoing
payout. It does not change the append-only public payout feed or claim state
machine. Tests use isolated PostgreSQL schemas and mocked NWC payouts; they do
not spend real funds. These protections and regression tests are not a
guarantee of zero vulnerabilities or legal compliance.

## Schema rollout

The new tables are declared in the shared Drizzle schema. The development
schema must exist before deploying the code, because withdrawal and staking
paths intentionally fail closed without it. Production schema changes follow
the normal Publish migration process; do not run development SQL against
production. `scripts/sql/yield-staking.sql` is the additive development/test
migration and leaves all historical earnings and claim schemas unchanged.
