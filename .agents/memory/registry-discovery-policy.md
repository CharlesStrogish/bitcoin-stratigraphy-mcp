---
name: Registry discovery policy
description: Supported directories and public, protocol-neutral discovery behavior.
---

The product has migrated fully to Glama and mcpservers.org. Do not reintroduce
other directory-specific badges, verification endpoints, dependencies, or
publication configurations.

**Why:** The user explicitly deprecated the former directory integration and
requested removal across the repository, including old documentation.

**How to apply:** Preserve the `com.bitcoinstratigraphy` registry identity,
all 16 canonical tool contracts, and existing Glama ownership documents.
Keep the generic public MCP server card, finite GET/HEAD discovery probes and
wildcard non-credentialed CORS: those are interoperability contracts, not
directory-specific features.

Preserve historical audit evidence exactly as recorded, including every file
tied to an OpenTimestamps receipt. Deprecated-directory text inside those
historical artifacts is an intentional exception to current-source cleanup.

**Why:** The user states immutable historical cryptographic integrity is
mandatory for the enterprise SLA; editing evidence would invalidate its receipt.

**How to apply:** Remove obsolete integration code and current marketing, but
never rewrite or delete historical audit bundles to obtain a zero-match scan.
