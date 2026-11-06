---
name: Public audit evidence
description: Integrity and privacy boundaries for the security page's downloadable validation evidence.
---

Publish observed runner summaries, including failures, skips, exit statuses and
the tested source scope. Do not equate automated regression counts with a
penetration audit, zero vulnerabilities, a model identity or MAX-mode telemetry.
The supplied auditor label is descriptive copy, not runner evidence.

**Why:** The user requested a publicly downloadable, hashed validation artifact
for machine verification. A SHA-256 digest proves matching bytes, not the truth
of the report's claims. Unfiltered test diagnostics may expose private data.

**How to apply:** Keep raw diagnostics private; publish allowlisted numeric
summaries and exact command outcomes. Hash the finalized downloadable bytes,
keep the page's displayed digest synchronized, and test that relationship.
State the validation's source scope and distinguish later artifact/UI checks
from the frozen test run; exclude repeated coverage-gate tests from aggregate
counts.
