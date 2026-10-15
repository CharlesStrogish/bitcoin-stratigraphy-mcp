---
name: Production rate-limit keys
description: How the shared public rate limit keys requests on the production Reserved VM, why the platform's own probes get 429s after each boot, and why those refusals are mostly missing from deployment logs.
---

Observed in production on 2026-10-15 (`trust proxy` 1, shared public budget
of 100 requests per 15 minutes):

- Requests through the public edge do not keep a stable key. Ten requests from
  one client, four of them on a single connection, each landed in an almost
  fresh bucket, so the per-client limit is not actually enforced per client.
- The platform's own probes share one stable key. They hit every service path
  (including `/agent-api`) in pairs 80 s apart, every 5 minutes. They are
  joined by roughly 75 boot-time health checks and probes in the first 20 s
  after the port opens. That filled the bucket about 3 minutes after launch.
  Probes then got 429 until the boot traffic left the window (05:12:53 to
  05:26:33 for that boot), and recovered exactly as predicted.
- Steady-state probe load is 15 paths × 6 bursts = 90 of the 100 per window.
  Each added service path adds 6.
- The general limiter runs before the request logger, so its 429s never reach
  the deployment log; only `/mcp` refusals (checked after the logger) appear.
  A probe burst that logs only `/agent-api` and `GET /mcp 429` means the other
  paths were refused, not skipped.

**Why:** An audit based on request logs reported green while the platform's
probes were being refused. The user asks for verified, fully green production
checks after each publish.

**How to apply:** Do not infer a client's budget from its own production
requests. Before changing the `trust proxy` depth, verify the real forwarded
chain: the wrong depth makes keys either global or spoofable. Count
service-path additions against the steady-state budget, and remember paid
swarm traffic must not get a blanket IP ceiling (enterprise-swarm-traffic.md).
When auditing deployment logs, treat missing burst paths as possible unlogged
429s.
