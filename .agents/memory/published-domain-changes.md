---
name: Published domain changes
description: Domain behavior encountered after changing this app's deployment target.
---

The app's previously advertised username-suffixed testing domain returned Replit's “This app isn't live yet” page after its Reserved VM publish, while the publishing service's current primary domain served the app normally.

**Why:** A valid build, healthy server, and correct port binding cannot make an obsolete deployment address resolve. Stale Nostr announcements, MCP metadata, and documentation can continue directing clients to the obsolete address.

The user designated https://bitcoinstratigraphy.com as the canonical public domain for all advertised URLs, metadata and package defaults. Remove old testing-domain references throughout the repository, including public documentation and configuration. MCP connection URLs must use https://bitcoinstratigraphy.com/mcp.

**Why:** The user requires external registries to parse the premium domain rather than the old testing URL.

**How to apply:** Obtain the current primary URL from the publishing service and probe it and any reported failing URL separately before changing server configuration. After a domain change, audit all public endpoint claims and diagnostics; republish updates to persisted metadata.

The user authorized server-backed frontend hosting specifically to return real
301 redirects from legacy `replit.app`, `replit.dev`, and `repl.co` hosts.
Canonical and loopback hosts must not redirect. Preserve the original path and
query, and keep the frontend, Express API, and enterprise companion separate.

**Why:** Static hosting cannot issue the required external 301 redirects;
API-only middleware would leave the legacy homepage indexable. The user explicitly
requires redirecting development domains too, so public development previews
will navigate to the canonical site.

**How to apply:** Preserve early routing guards without changing paid execution.
Retain prerendered page heads and public security/CORS headers when changing the
frontend server. Test actual Host headers with node:http: this workspace's Fetch
implementation rewrites a supplied Host to match the request URL.