---
name: Production SEO safeguards
description: User constraints when fixing SEO tests or modifying public discovery.
---

Do not weaken production SEO to satisfy outdated tests. Inspect assertion differences first; when metadata and crawler configurations are valid and intentional, update test expectations instead.

Preserve Google indexing, Knowledge Graph properties, full public crawler visibility, production canonical metadata, structured schemas and existing author attribution. Do not change crawler rules or middleware in a way that blocks search engines or AI crawlers.

**Why:** The user explicitly required these safeguards when approving SEO test repairs.

**How to apply:** Prefer test-only alignment for stale branding or discovery assertions. Any genuinely required minor production metadata fix must retain these properties. Report exactly what changed and confirm the full requested test suite.

Preserve registry compatibility when adding publisher attribution: supplement the existing Glama release, pricing and tool-count fields rather than replacing the registry document with a minimal publisher-only object.

**Why:** The user explicitly selected preservation of registry compatibility during the system audit.

**How to apply:** Add attribution without dropping existing metadata. Distinguish defunct application domains from external registry identifiers: verify directory links before rewriting a legacy-looking identifier, since an apparently cleaner replacement can return 404.
