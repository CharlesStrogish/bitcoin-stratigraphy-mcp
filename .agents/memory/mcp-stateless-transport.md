---
name: Dual-era MCP transport
description: Rules for the stateless MCP 2026-07-28 path alongside handshake-era clients on SDK v1.
---

The /mcp endpoint serves two eras side by side and never mints a session.

- Era selection happens per request, before payment gates: `_meta` protocol version, a non-legacy
  `MCP-Protocol-Version` header, or `server/discover` means stateless; everything else keeps the
  SDK initialize flow.
  **Why:** the user asked for 2025-11-25 clients to keep working; the existing contract suite and
  scripts all use handshake-era headers without `_meta`.
- SDK v1.31 does not know 2026-07-28. Its HTTP transport rejects unknown protocol headers, so
  stateless requests bypass it and run through a fresh server on an in-memory linked pair.
  **How to apply:** an SDK v2 migration should replace this bridge, not layer on top of it.
- Stateless failures must be strict JSON-RPC. The SDK's error schema is `.strict()`, so the legacy
  top-level challenge fields (macaroon, invoice, ...) would make modern clients reject the reply.
  They move into `error.data`. The handshake-era range -32000..-32019 is remapped to the HTTP
  status (402, 429, 401, 403, 404) or a standard code.
- `Mcp-Method`/`Mcp-Name` are routing hints for load balancers. Payment and rate-limit decisions
  keep reading the body; a mismatched header is rejected (-32020) rather than trusted.
- Scaling caveat: macaroon usage and revocation are Postgres-backed in production (shared), but
  the public per-IP limiter and L402 challenge windows are in memory per instance, so N instances
  allow roughly N times the free budget per IP.
