---
name: Cookbook dependency security
description: Security and scope decisions for optional Python client-framework examples.
---

Keep the optional CrewAI source example and free-discovery mode, but do not
reintroduce its runtime dependency chain while ChromaDB has unresolved critical
vulnerabilities. Do not suppress the publishing security gate to enable an example.

**Why:** The user approved removing CrewAI/ChromaDB dependencies rather than
blocking publication of the Node website and API. Neither deployed service needs
those frameworks. A check on October 2, 2026 found even the latest ChromaDB release
affected, so a supported resolver override was not a security fix.

**How to apply:** Check upstream advisories and rerun a dependency audit before
restoring CrewAI execution. Audit both the shared Python project and cookbook
requirements, not just packages imported by the deployed services. Keep optional
SDK instructions accurate about temporarily unavailable execution modes.

Apply the same source-preservation policy to optional LlamaIndex execution while
its required NLTK dependency has no patched release.

**Why:** On October 4, 2026, the latest NLTK release remained affected by a
high-severity model-file sandbox bypass. Optional consumer manifests count toward
the project's dependency audit even when those packages are not installed in the
shared Python environment.

**How to apply:** Audit optional framework requirements as well as the project
lockfile. Restore LlamaIndex installation only when the complete resolved
dependency chain is safe; do not remove the preserved example source or recommend
installing vulnerable packages to make it run.