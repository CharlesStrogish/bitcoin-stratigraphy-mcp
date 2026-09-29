---
name: MCP catalog size
description: Discovery tool-count constraint and how to preserve behavior when consolidating MCP tools.
---

Keep the advertised MCP catalog within the user's target 3–15 tool band by grouping related operations under explicit mode selectors, rather than advertising adjacent operations as extra standalone tools.

**Why:** The user specifically targets Glama's 3–15 tool-count scoring band. Exceeding it can lower the count score even if individual tools are well documented. A smaller catalog is not worth ambiguous inputs or weakened payment checks.

**How to apply:** When adding related verification or payment behaviors, use exclusive mode-specific schemas, preserve the existing default behavior for callers who omit the selector, and keep HTTP authentication and paid execution gates bound to the selected operation. Update server-card, OpenAPI, SDK, documentation, and discovery tests together. This is a catalog-size target, not proof of an externally measured Glama score.