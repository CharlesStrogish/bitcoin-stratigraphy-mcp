---
name: Stdlib trace coverage exit status
description: Why coverage from Python's trace module must be paired with a plain test run.
---

Do not use the stdlib trace coverage command's exit status alone as evidence
that the wrapped tests passed.

**Why:** Running unittest through python -m trace produced coverage and exited
successfully while unittest explicitly reported a failure. The ordinary
unittest invocation correctly returned a failing exit status.

**How to apply:** Run plain unittest separately and inspect its success result;
use trace only to measure coverage, checking its reported test result too.
Never equate 100% line coverage with passing tests or branch coverage.
