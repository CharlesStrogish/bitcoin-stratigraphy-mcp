---
name: Published domain changes
description: Domain behavior encountered after changing this app's deployment target.
---

The app's previously advertised username-suffixed testing domain returned Replit's “This app isn't live yet” page after its Reserved VM publish, while the publishing service's current primary domain served the app normally.

**Why:** A valid build, healthy server, and correct port binding cannot make an obsolete deployment address resolve. Stale Nostr announcements, MCP metadata, and documentation can continue directing clients to the obsolete address.

The user designated https://bitcoinstratigraphy.com as the canonical public domain for all advertised URLs, metadata and package defaults. Remove old testing-domain references throughout the repository, including public documentation and configuration. MCP connection URLs must use https://bitcoinstratigraphy.com/mcp. Request handling remains host-agnostic and environment overrides stay authoritative.

**Why:** The user requires external registries to parse the premium domain rather than the old testing URL.

**How to apply:** Obtain the current primary URL from the publishing service and probe it and any reported failing URL separately before changing server configuration. After a domain change, audit all public endpoint claims and diagnostics; republish updates to persisted metadata.