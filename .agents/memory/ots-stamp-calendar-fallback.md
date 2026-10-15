---
name: OTS stamp calendar fallback
description: How the Node API's OpenTimestamps stamping treats slow or unreachable public calendars, and why boot-time stamping is delayed.
---

Stamp through one calendar per CLI attempt: a.pool, then b.pool, then alice.
Each attempt has a short calendar wait and its own process cap. Only a process
timeout, or the CLI's "need at least N attestation(s) but received N" exit,
counts as a calendar outage that moves to the next calendar. Any other failure
is a real error and must surface immediately. When every calendar fails, log
a warning and retry once later, never an error. The first scheduled stamp
waits five minutes after boot. The Python anchor's resume and the proof
upgrader wait the same time.

**Why:** The boot-time timeout came from cold-starting the Nix Python CLI
while both APIs were booting; that start-up consumed the whole 20 s process
timeout. The CLI's calendar submission thread is not a daemon, so a stalled
calendar is bounded only by its socket timeout. The per-attempt process cap is
what bounds it. Tests against local fake calendars confirmed the CLI reports a
refused, silent or erroring calendar with exit status 1 and that message.

The slow start outlasts the boot. On 2026-10-15, the first `ots` runs after a
publish still exceeded the 10 s info limit on the production VM: the 5-minute
scheduled anchor failed and was not retried until the 6-hour run. Provenance
chain and anchor lookups returned 503 after 10 s, 12 minutes after boot. After
a few killed attempts the same lookup took 1–3 s; locally `ots info` takes
about 1.1 s.

**Mitigation (user-specified schedule, 2026-10-15):**
- 90 s after the first recovery attempt, warm the CLI with a 60 s cap, then
  read the current anchor so the stored receipt's inspection is cached.
- The first stamp stays at 5 minutes. Any failed scheduled stamp (calendar
  outage, CLI timeout or other error) is retried once, 10 minutes later.
- `ots info` output depends only on the receipt bytes, so successful
  inspections are cached by their hash. Concurrent inspections share one run,
  and failures are never cached. The inspection limit is 30 s.
- Public reads still check the stored receipt's digest binding and fail closed
  (503) when that check fails. The cache keeps reads fast; never skip the
  inspection.
- Unproven: whether a cold production `ots info` before the 90 s warm-up
  always finishes within 30 s. After a publish, read the warm-up's durationMs
  and the first provenance reads in the deployment log.

**How to apply:** Keep the approved calendar set unchanged and retries
stamping the same bytes. A pending calendar receipt is not Bitcoin
verification. Test the real CLI only against local fake calendars, never the
public ones. When testing locally, use the PATH caveat in
python-environment-checks.md.
