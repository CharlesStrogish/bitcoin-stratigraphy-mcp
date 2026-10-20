---
name: Publishing security validation
description: Distinguish successful builds and patched dependencies from security-gate acceptance.
---

Do not equate a successful build or patched active environment with clearance of the publishing security gate. Reconcile reported package versions with committed lockfiles and actual project-runtime imports.

**Why:** A publish was blocked by critical Python dependencies despite successful frontend/backend compilation. After updating the dependencies, repeated dependency audits continued reporting an older certificate package even after cache cleanup and committing the patched lockfile; the reason for this discrepancy was not established.

**How to apply:** Inspect the failed build's exact security findings first. Keep security floors and the lockfile aligned, verify compatibility with the project interpreter, and distinguish locally validated remediation from confirmed acceptance by a fresh publishing scan. Report unresolved scanner/version discrepancies rather than claiming zero critical findings or disabling checks.

For production-only remediation, audit Node with `pnpm audit --prod` and compare Python findings against both locked and installed versions before selecting upgrades. Already-patched dependencies should not be upgraded merely to chase a finding that names an older version.

**Why:** The workspace dependency scanner reported older versions of several Python libraries while the current lockfile and runtime were already patched; independent OSV queries against the actual installed versions returned no findings.

**How to apply:** Preserve separate claims for current production dependency checks and the workspace Security Center results. Inspect the output of `pnpm audit --prod --fix` before installation: it can copy workspace overrides into the root manifest and emit unbounded version ranges. Keep existing overrides intact and constrain remediation to tested compatible releases.
