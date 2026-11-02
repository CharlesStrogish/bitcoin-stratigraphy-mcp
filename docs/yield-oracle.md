# Nostr Proof-of-Yield oracle

Successful mainnet withdrawals through `POST /api/claim-yield` schedule a
best-effort public Nostr Kind 1 note **after** durable settlement and the HTTP
response. Pending claims, rejected claims, failed payouts and replay errors do
not trigger a note.

## Secret

Set `NOSTR_SERVER_PRIVKEY` through the project's secure Secrets tooling, using
either a 64-character hexadecimal Nostr private key or an `nsec` key. This is a
dedicated oracle identity; there is no fallback to `NOSTR_PRIVATE_KEY` or the
wallet's NWC signing secret. Never put the key in source code or chat.

## Public note

> An autonomous agent just settled a [AMOUNT] satoshi yield withdrawal from the BitcoinStratigraphy.com L402 Data Engine. 100% Mainnet execution.

`[AMOUNT]` is the actual settled withdrawal amount. Millisatoshis are formatted
exactly as decimal satoshis, without rounding. The signed note includes a public
timestamp, a `proof-of-yield` topic and independent randomness so equal amounts
in the same second remain distinct events. It contains no agent identity,
claim ID, invoice, payment hash, preimage or bearer credential.

Relays:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.primal.net`

## Failure boundaries

Signing and relay operations run in a later event-loop turn, not in the payout
transaction or HTTP response path. Each broadcast has a five-second deadline
and always attempts relay cleanup. Missing or invalid keys, relay rejection,
connection failures, timeouts and logging failures never change a settled payout.
Warnings contain only fixed event codes, not raw provider exceptions.

This is best-effort broadcasting, not a durable outbox or independent payment
verification. No database schema changes are needed. A process exit can lose an
unsent note, and the broadcaster bounds concurrent work to 16 publications.
Operator reconciliation is not a new withdrawal and does not itself publish a
note. Tests must inject mocked relay pools; the default transport is disabled
under `NODE_ENV=test` even when a signing secret is present.
