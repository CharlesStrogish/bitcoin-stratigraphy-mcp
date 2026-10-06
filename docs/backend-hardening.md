# Backend request protection

Free backend HTTP traffic shares a **100 requests per 15-minute sliding window**
budget per client IP across public endpoints. This includes docs, health and
discovery probes, server cards, training exports, public verification and
public preflights. The free MCP tools `stratigraphy.list` and `proof.list` and
MCP discovery methods/probes use that same budget.

All registered paid MCP tools, including aliases and `proof.notarize`, are
exempt from execution IP rate limiting. Their existing payment checks, invoice
issuance abuse safeguards, single-use
credentials, entitlement quotas and request-size constraints still apply.
Sending an Authorization header does not exempt a free tool. Existing paid
REST endpoint policies are unchanged.

Rejected requests return HTTP 429, `Retry-After`, `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Policy`; MCP errors retain JSON-RPC framing.
Rejections are not cacheable. IPv4-mapped addresses normalize to IPv4; native
IPv6 addresses share a /64 budget to prevent address rotation within a subnet.
IP identity uses Express's trusted-proxy resolution, not caller-controlled raw
forwarding headers. Keep the configured one-hop proxy trust consistent with
the actual ingress topology; do not expose this listener directly behind a
different or bypassable proxy chain.

The native store is bounded to 10,000 identities and does not evict active
counters when full. New identities are rejected until expired entries are
reclaimed. Limits are process-local, reset on restart and are not a distributed
or volumetric DDoS defense. Multiple replicas need a shared limiter or an edge
policy with the same paid-MCP exclusions. Static frontend assets are served by
the frontend hosting service, not this Express application; protect those and
network bandwidth at ingress/CDN/WAF level.

## Repeatable checks

- `pnpm format:check`: Prettier checks for tracked/active JS, TS, React and CSS;
  Ruff formatting checks for first-party Python.
- `pnpm lint:python`: unused Python imports and variables.
- `pnpm typecheck`: workspace TypeScript checks.
- `pnpm test`: workspace and API regression suites, including free-budget
  exhaustion, expiry, IP isolation and paid MCP/notarization exemptions.

Canonical legal files, generated code, data and historical distribution
artifacts are intentionally excluded from bulk formatting.
