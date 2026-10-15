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

**Platform behaviour (deployment logs):** the checker probes every service path
prefix (`/agent-api`, `/api`, `/mcp`, `/docs`, ...) through the public router,
retrying failures every second or two; each probe times out after about 10 s
while held. "all artifact ports are open" is logged the moment the last port
opens. Holding probes is safe.

**Production evidence (seconds from "starting up user application"):**
- Before listen-first (2026-10-14): 500s for 45 s (Node) and 51 s (Python).
  Python became ready at 51 s.
- After listen-first (2026-10-15):
  - Node: the process itself started only at 8.6 s, and its port opened at
    10.5 s.
  - Python: port at 12.8 s, ready at 32 s. The application load took 16 s on
    the cold VM, versus 0.8 s locally.
  - 500s lasted 10 s (Node) and 13 s (Python).
- The remaining window is mostly process launch on a cold VM, not application
  code.
- Production Python stdout is block-buffered, so `print` lines (license
  messages) appear late. Time boots from stderr logger lines and Node's
  portBoundMs/applicationLoadedMs instead.

**How to apply:** Never import application modules from the entry bootstrap;
keep heavy libraries lazily imported and expensive module-level work (such as
YAML parsing) out of evaluation. In Python, even `import asyncio` costs about
130 ms, so the pre-bind module imports only os/socket/sys/time. Load the
application on a daemon thread, not `asyncio.to_thread`: `asyncio.run` waits
for executor threads at exit, so SIGTERM during the import would hang until it
finished. Measure with the startup harnesses, comparing against a copy of the
previous build rather than trusting a single run, and confirm with the phase
timings in the deployment log after each republish.
