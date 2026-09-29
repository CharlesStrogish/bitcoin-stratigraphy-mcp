---
name: API suite rate-limit timing
description: An intermittent per-IP budget assertion during full API test runs.
---

The full API suite intermittently reports a remaining per-IP request budget of 59 when a test expects 60, even when the change being tested touches only MCP descriptions. A subsequent unmodified full-suite run passed.

**Why:** A one-off budget mismatch is not evidence that an unrelated metadata edit broke rate limiting; changing limiter semantics to mask a transient assertion would be risky.

**How to apply:** If this assertion fails during unrelated work, inspect the failure and confirm it independently before changing limiter implementation or test expectations. Report a confirmed intermittent failure rather than claiming every attempt passed.