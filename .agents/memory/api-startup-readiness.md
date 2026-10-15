---
name: API startup readiness
description: Why the Node API and the Python Enterprise Agent API bind their ports before loading the application, and what must stay off the startup path.
---

Both API processes bind their port first and hold early requests; the
application loads afterwards. Node: escrow routes wait on durable-ledger
recovery. The one-pass zk warm-up and the first OpenTimestamps stamp both wait
5 minutes after the first recovery attempt (user decision, 2026-10-15), and
proofs are verified on demand until the warm-up runs. The first pass carries
most of the cost (library load and curve build: about 1.3 s locally versus
0.1 s for each further pass), so the delay, not the pass count, keeps it off
the boot.
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
- After the lazy Python imports (second publish, 2026-10-15):
  - Python: port at 13.1 s, ready at 27.1 s. That is 14.0 s after the port
    opened: uvicorn import 3.1 s, application load 10.5 s (0.33 s in dev),
    startup 0.3 s.
  - Node: the process started 11.5 s after launch and its port opened at
    15.0 s. Health checks were first answered at 26.7 s, because the zk
    warm-up's single-threaded Groth16 passes block the event loop (6.9 s on
    the VM versus 0.5 s locally).
  - A dashboard page load's escrow requests reached the new machine 18.8 s
    into the boot.
- The deployment is a Reserved VM (gce): cold boots happen on publish or
  restart. The checker probes the new machine's local router (127.0.0.1:1104),
  but other requests can also arrive before its checks pass.
- The remaining window is mostly process launch on a cold VM, not application
  code. Boot-time CPU and file work there runs 10–30 times slower than
  locally, so local measurements cannot prove a production target.
- Production Python stdout is block-buffered, so `print` lines (license
  messages) appear late. Time boots from stderr logger lines and Node's
  portBoundMs/applicationLoadedMs instead.

**Python application load (2026-10-15 change):** MCP (fastapi_mcp and the MCP
SDK), the App Storage/Google Cloud SDK, OpenTimestamps with python-bitcoinlib,
and httpx's `rich` command-line module now load only where used. The MCP server
builds on a daemon thread shortly after startup. The application import fell
from 907 to 325 modules. Local timings: 0.84 s versus 2.1 s with warm
bytecode, and 1.8 s versus 4.4–5.8 s without bytecode. uv does not compile
bytecode by default, so the production build passes `--compile-bytecode`.
Readiness no longer waits for the first live refresh. `supply-metrics` waits a
bounded 5 s for it and otherwise returns the documented 503. Never serve a
cached or archived snapshot there: that breaks the no-stale contract (90 s
maximum age).

**How to apply:** Never import application modules from the entry bootstrap;
keep heavy libraries lazily imported and expensive module-level work (such as
YAML parsing) out of evaluation. In Python, even `import asyncio` costs about
130 ms, so the pre-bind module imports only os/socket/sys/time. Load the
application on a daemon thread, not `asyncio.to_thread`: `asyncio.run` waits
for executor threads at exit, so SIGTERM during the import would hang until it
finished. Measure with the startup harnesses, comparing against a copy of the
previous build rather than trusting a single run, and confirm with the phase
timings in the deployment log after each republish. Synchronous CPU work after
the port opens, such as the main-thread zk warm-up, still blocks held requests.
A burst of trivial health checks completing together in the log shows a
blocked event loop.
