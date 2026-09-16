---
name: Paid SSE lifecycle
description: Resource and authentication invariants for persistent paid event streams.
---

Authenticate and verify payment completely before sending SSE headers, and install disconnect handling before beginning asynchronous authentication.

**Why:** A client can disconnect while revocation, usage, or wallet checks are pending; attaching listeners or timers afterward creates permanent resource leaks.

**How to apply:** Use a request-scoped abort signal for every cancellable authentication dependency, recheck connection state after each await, and make stream setup and cleanup idempotent.

Shared telemetry refresh loops must start with the first listener and stop after the last listener leaves. Per-client heartbeats must be cleared on disconnect.

**Why:** Persistent streams otherwise retain timers, listeners, database work, or provider clients after agents close sockets.

**How to apply:** Drop live updates while the response is backpressured, cap external response bodies before parsing, cancel non-success bodies, and release acquired database clients in finally blocks.