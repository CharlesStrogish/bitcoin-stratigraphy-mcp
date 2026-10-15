---
name: API suite rate-limit timing
description: An intermittent per-IP budget assertion during full API test runs.
---

The full API suite intermittently reports a remaining per-IP request budget of 59 when a test expects 60, even when the change being tested touches only MCP descriptions. A subsequent unmodified full-suite run passed.

**Why:** A one-off budget mismatch is not evidence that an unrelated metadata edit broke rate limiting; changing limiter semantics to mask a transient assertion would be risky.

**How to apply:** If this assertion fails during unrelated work, inspect the failure and confirm it independently before changing limiter implementation or test expectations. Report a confirmed intermittent failure rather than claiming every attempt passed.

The discovery `Retry-After` assertion can also fail under CPU contention: it
expects at least 899 seconds left in a 900-second window after sending over
100 requests. If those requests take several seconds, that lower bound is no
longer valid. An unchanged API-suite rerun without a concurrent frontend build
passed.

**Why:** A wall-clock test duration can consume more of the window than the
assertion allows; this is not evidence of a homepage regression.

**How to apply:** Avoid concurrent builds when confirming this test, and do not
change production rate-limit semantics to satisfy its timing assumption.