---
name: Dependency release policy
description: User-required audit scope and limits of security claims for releases.
---

The user requires a zero-vulnerability dependency audit, across all severities
and including development dependencies. Include the standalone router, shared
Python lockfile, and optional consumer requirements, not only the production npm
dependency tree.

**Why:** The user explicitly said, “A zero-vulnerability audit is strictly
mandatory.”

**How to apply:** Verify the actual resolved versions against current advisories
before releasing. Distinguish independent audit results from unresolved platform
scanner results. A clean dependency audit is not mathematical proof of security
or an enterprise compliance certification.
