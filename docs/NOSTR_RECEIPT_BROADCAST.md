# Asynchronous receipt mesh

Completed paid MCP single-tool executions, finalized paid pipeline receipts
(including explicitly failed/interrupted outcomes), and committed L402 RFC 6962
escrow settlements schedule a best-effort public Nostr proof. Zero-price and
in-progress pipeline journals are not published.

Pipeline broadcasting decorates the existing receipt store, after its successful
save, without changing pipeline execution or settlement. Escrow publishing starts
after COMMIT. Single tools enqueue a background journal: the settled invoice
amount is read from the existing revenue ledger, a minimal Ed25519 completion
receipt is saved in the existing `enterprise_affiliate_security` JSONB table,
and only then is its public proof broadcast. No new schema or indexes are needed.
For same-tool passes, the amount is the invoice total, not an invented per-use
payment. A failed journal write is logged and never advertised as persisted.

All hashing, journaling, Nostr signing and network operations run in a deferred
background job. Request handlers never await the mesh. Signing uses the existing
`NOSTR_PRIVATE_KEY` (hex or nsec); missing/invalid keys do not affect settlement.
Events use NIP-78 kind 30078, a deterministic `d` tag derived from the evidence
commitment, and a `receipt-proof` topic. The destinations are relay.damus.io,
nos.lol and relay.primal.net.

The event content is a strict allowlist: schema, receipt type, task/evidence
SHA-256 commitments, invoice settlement amount, execution status and timestamp,
plus the actual RFC 6962 root or pipeline steps commitment when available.
Pipeline commitments are **not** described as RFC 6962 roots. No raw arguments,
results, payment hashes, preimages, macaroons, capabilities, agent identities or
complete private receipts are published. Nostr event authenticity attests the
publisher's statement; it does not independently prove Lightning settlement or
legal compliance. Auditors still need the original private evidence and trusted
issuer identity.

Each relay has an independent three-second deadline; rejection, synchronous
transport failure and late rejection are caught, logged without secret-bearing
payloads, and cannot invalidate or delay the API's response. Connections are
destroyed after each broadcast. At most four jobs run concurrently with a total
256-job bound; overflow is explicitly logged and dropped, never backpressured
onto agents. Delivery is best-effort, not a durable outbox: a crash, missing
invoice journal, overload or relay refusal may prevent publication. PostgreSQL
evidence remains authoritative; there is no automatic payment replay, refund,
retry, or claim that every relay retained an event.
