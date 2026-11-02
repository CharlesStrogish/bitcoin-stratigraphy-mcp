# Enterprise settlement webhook

Set `ENTERPRISE_WEBHOOK_URL` in the API server environment to opt in. Leave it
unset to disable delivery. Use an HTTPS endpoint you control; HTTP is supported
for private-network receivers. URLs with embedded usernames/passwords and
non-HTTP protocols are refused. Redirects are not followed.

After PostgreSQL commits a new incoming L402 revenue record, the server schedules
one best-effort JSON POST containing exactly:

```json
{
  "transaction_id": "the-persisted-revenue-record-id",
  "satoshis_captured": 250,
  "yield_distributed": 52.5,
  "timestamp": "2026-11-02T15:00:00.000Z"
}
```

Amounts are in satoshis; fractional satoshis are retained for the calculated
21-percent allocation. `yield_distributed` is the requested monitoring field
name, **not evidence of an outgoing Treasury payout**. The timestamp is the
persisted incoming settlement timestamp, not delivery time.

Only committed new L402 rows trigger delivery. Duplicate redemptions,
unsuccessful database writes and NIP-90 revenue do not. No payment hash,
preimage, macaroon, agent identity, wallet credential or client identifier is
sent. This webhook does not change revenue allocation or withdrawal execution.

Delivery runs on a later event-loop turn and is never awaited by the request.
Each process allows at most 16 scheduled/in-flight deliveries, with a three-second
timeout and no unbounded queue. Timeouts, network errors, redirects and receiver
errors are ignored. Response bodies are discarded. Destination URLs and delivery
errors are not logged because webhook URLs can contain bearer credentials.

This is fire-and-forget monitoring, not a durable delivery system. Events may
be lost during shutdown, saturation, or receiver outages; there are no automatic
retries or delivery guarantees. Deduplicate by `transaction_id` on the receiver.
The endpoint is global to this server, not a per-tenant registration mechanism.

The four-field body is not a native Slack or Datadog intake envelope. Configure
a corporate receiver/adapter to map it into those systems' expected formats.
Keep credential-bearing receiver URLs in the secret store.
