---
name: Validation freshness
description: Confirm that automatic test results cover the final source rather than earlier edits.
---

A finished automatic workflow is not sufficient evidence that the latest edits passed. Confirm that its output includes the newly added or changed regression before relying on it.

**Why:** An earlier green automatic run did not include the final payment-contract regression; a later run exposed mismatched published schemas and shared fixture pollution.

**How to apply:** Match the changed test names against the completed log. If the result predates an edit, run the affected check against the final source rather than reporting the older run as current. Fix fixture isolation without weakening payment verification.
