---
name: API startup readiness
description: Why the Node API and the Python Enterprise Agent API bind their ports before loading the application, and what must stay off the startup path.
---

Both API processes bind their port first and hold early requests; the
application loads afterwards. Node: escrow routes wait on durable-ledger
recovery; zk warm-up and the OpenTimestamps schedule start in the background.
Python (`/agent-api`): the license check stays ahead of the bind, and held
requests are released only after the application's real lifespan startup.

**Why:** Republishing produced about 47 seconds of proxy 500s because the port
opened only after module evaluation, escrow recovery and zk warm-up. The user
requires no 500 window for connecting agents, escrow never served before
recovery, and non-critical network/warm-up work never blocking listening.

**Platform behaviour (deployment log, 2026-10-14 publish):** the checker probes
every service path prefix (`/agent-api`, `/api`, `/mcp`, `/docs`, ...) and
retried failures every few seconds for about 50 seconds before promoting, then
logged "all artifact ports are open; application health checks may still be
pending". Holding probes is therefore safe. On that cold VM the Python API
became ready about 54 s after the first failed probe, versus about 3 s locally.

**How to apply:** Never import application modules from the entry bootstrap;
keep heavy libraries lazily imported and expensive module-level work (such as
YAML parsing) out of evaluation. In Python, even `import asyncio` costs about
130 ms, so the pre-bind module imports only os/socket/sys/time. Load the
application on a daemon thread, not `asyncio.to_thread`: `asyncio.run` waits
for executor threads at exit, so SIGTERM during the import would hang until it
finished. Measure with the startup harnesses, comparing against a copy of the
previous build rather than trusting a single run, and confirm with the phase
timings in the deployment log after each republish.
