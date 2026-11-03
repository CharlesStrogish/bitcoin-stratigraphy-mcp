# Genesis Grant

New authenticated NIP-98 identities receive ten invoice-free individual MCP
`tools/call` executions across all paid tools and their aliases. Sign each POST's
exact public URL, method and body using a fresh kind-27235 NIP-98 event in
`Authorization: Nostr <base64-event>`. `X-Nostr-Authorization` is also supported.
A bare pubkey or self-declared agent ID does not qualify.

Successful grant responses carry:

```http
X-Genesis-Grant: 9 calls remaining before L402 activation
Cache-Control: no-store
```

The tenth successful execution reports `0 calls remaining before L402 activation`.
After exhaustion, the ordinary L402 invoice/macaroon challenge applies. Anonymous
calls remain paid. Requests already carrying payment credentials keep their
normal payment verification; a grant never overrides a rejected credential.
Grant calls are not paid settlements and do not earn routing yield, paid-history
credit, or a settlement receipt.

Public discovery, protocol handshakes and the two free sandbox capabilities stay
free without consuming the grant. Invoice-only requests, REST endpoints and
composite pipeline/batch requests keep their existing billing contracts.

The `genesis_grants` PostgreSQL row stores each pubkey's lifetime successful
executions and in-flight reservation IDs. Capacity is reserved atomically before
execution across workers, tools, reconnects and restarts. Known tool failures
refund their slot; there is no daily or session reset. Queued webhook/polling
executions hold their reservation until completion. The header reports capacity
available after the current reservation, including other concurrent calls.

Accounting failures return 503 rather than free untracked execution. A worker
crash may leave a slot reserved: it is deliberately not automatically refunded,
because the tool may have completed external work before the crash. Operators
must establish the outcome before reconciling an abandoned reservation.

The development schema includes the new table; managed production schema changes
are applied through the normal Publish flow. No production migration is run by
this feature.
