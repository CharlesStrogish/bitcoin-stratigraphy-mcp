---
name: MCP async webhooks
description: Rules for the webhook_url zero-polling flow on paid MCP tools (202 contract, SSRF policy, payment ordering, test hazards).
---

The user asked (2026-10-18) for a specific contract: `webhook_url` on `proof.submit` and
`stratigraphy.get_range`; paid call → HTTP 202 with JSON-RPC `result {task_id, status:"pending"}`;
one POST of the final result or error to the callback; synchronous behaviour when omitted.
The user cited SEP-1686, but this webhook path is deliberately distinct from the
MCP Tasks extension: its acknowledgement is not `resultType:"task"`. The user
subsequently requested SEP-2663 polling alongside it; an explicit callback URL
must continue to select this existing push contract even for Tasks-capable clients.

**Why:** the official Tasks flow returns a task handle in a 200 result and expects polling; the user
explicitly wanted 202 plus push delivery. Official SDK clients ignore 202 bodies, so webhook calls
need a direct HTTP client. Mention this rather than silently switching semantics.

**How to apply:**
- Check the callback (static URL policy plus a DNS answer that must be entirely public) and queue
  capacity before any invoice is issued. All DNS failures share one generic message, so the endpoint
  cannot be used to probe internal names.
- Dispatch only after the payment gate calls next. Never mutate `req.body` (NIP-98 signs its bytes).
  Never forward `webhook_url` to the data backend, `submitZkProof`, the proof archive or Nostr.
- Credentials with a `max_target` caveat must still prefetch the range before the 202, so a caveat
  refusal never consumes payment.
- Log the callback host only; paths and query strings can carry the receiver's secret.
- The name `webhook_url` is user-specified and deliberately snake_case. The MCP contract test
  enforces camelCase input names, so it has a narrow exception for these two tools; keep the name
  (the required description sentence names it) rather than renaming it to match the convention.
- Tests that hold the backend to prove "202 before the work finishes" hang forever if the code
  regresses to inline execution. Use a self-releasing hold and a per-test timeout.
- Possible follow-ups the user has not requested: durable task storage, a status endpoint.

## Signed callbacks (added 2026-10-18 at the user's request)

Callbacks follow the Standard Webhooks asymmetric scheme with the existing tool-integrity Ed25519
key ("zero configuration": receivers use `server_public_key` from integrity.json). The user first
asked for the `v1,` prefix, then chose `v1a,` when told the spec reserves `v1` for HMAC-SHA256.

**Why:** one published key means no per-receiver secret exchange; `v1a` keeps standard verifier
libraries from misreading an Ed25519 value as HMAC.

**How to apply:**
- Signed content is `${task_id}.${unix_seconds}.${exact body}`; sign each attempt afresh so
  retries carry a current timestamp. Keep the payload body unchanged (no spec envelope).
- Fail closed: an unusable key refuses webhook calls with 503 before invoicing, and a queued task
  whose key cannot load is dropped, never posted unsigned.
- Rotating the integrity key (or the secret it derives from) also breaks webhook receivers' pins;
  the server sends one signature, not a dual-signed transition.
