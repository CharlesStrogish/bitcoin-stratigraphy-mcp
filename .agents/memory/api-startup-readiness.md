---
name: API startup readiness
description: Why the API binds its port before loading the application, and what must stay off the startup path.
---

The API process entry only binds the port and holds early requests; the
application bundle loads afterwards and attaches to the already-listening
server. Escrow routes wait on durable-ledger recovery; zk warm-up and the
OpenTimestamps schedule start in the background after that.

**Why:** Republishing produced about 47 seconds of proxy 500s because the port
opened only after module evaluation, escrow recovery and zk warm-up. The user
requires no 500 window for connecting agents, escrow never served before
recovery, and non-critical network/warm-up work never blocking listening.

**How to apply:** Never import application modules from the entry bootstrap;
keep heavy libraries lazily imported and expensive module-level work (such as
YAML parsing) out of evaluation. Measure with the startup harness against a
disposable database, comparing against a copy of the previous build rather
than trusting a single run. Local timings understate production by an order of
magnitude, so confirm with the phase timings in the deployment log after each
republish.
