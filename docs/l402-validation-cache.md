# L402 cryptographic verification cache

The API server uses `lru-cache` to reuse successful macaroon HMAC-chain
verification and strict caveat parsing. This is a process-local optimization,
not a cached authorization decision or a distributed session store.

- Production route instances share a cryptographic cache capped at 10,000
  entries and 32 MiB of accounted storage. An entry larger than 256 KiB is not
  retained. Accounted storage includes an overhead allowance, not a guarantee
  about total server memory.
- Keys fingerprint the exact encoded token and issuer secret. Parent and child
  credentials, modified tokens, and issuer-key changes cannot reuse each other's
  verification result. Failed verification is never cached.
- Entries expire at the earliest root or delegated deadline. Reading an entry
  updates LRU order, not expiration. Expired entries are removed lazily and
  remain subject to the entry and byte budgets.
- Cached results are detached before use so a caller cannot mutate another
  request's validated caveats.
- Every paid redemption still enforces current expiration, request/agent/tool
  binding, live revocation, and atomic consumption of all inherited quota
  scopes. The existing PostgreSQL stores remain authoritative across workers.
  Revocation database failures fail closed even after the cache is warm.
- Existing positive payment-settlement caching remains separate. In-flight
  settlement lookups are coalesced and bounded; cache capacity errors never
  grant access.

The regression suite covers cache reuse, issuer rotation, tampering, descendant
and root expiry, mutation isolation, entry/byte limits, lookup failures,
revocation outages, and concurrent quota exhaustion. Caching reduces repeated
CPU work; it does not provide zero latency or eliminate authorization database
queries.
