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

Blog content must remain readable without client-side JavaScript, with article
metadata and `BlogPosting` JSON-LD already present in the initial head.

**Why:** The user explicitly requires these properties to drive organic
enterprise traffic without affecting the existing dashboard or payment flows.

**How to apply:** Preserve the no-JavaScript publication boundary when extending
the blog. Do not replace static article documents with a client-fetched Markdown
view or let the dashboard SPA overwrite them after load. Keep future authoring
changes compatible with the local Markdown/frontmatter workflow.

Keep the B2B Product's structured offers USD-only; retain Lightning pricing in
the separate MCP software schema and public payment instructions.

**Why:** The user requires strictly USD Product offers for Google structured
data. Re-labeling a BTC amount as USD would misrepresent pricing.

**How to apply:** Preserve both payment rails operationally. Describe scanner
credits as a digital service without inventing reviews, shipping, or return
policies; digital classification alone does not guarantee Google suppresses
optional merchant warnings.
