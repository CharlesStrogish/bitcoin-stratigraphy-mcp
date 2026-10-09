---
name: MCP catalog size
description: Discovery tool-count constraint and how to preserve behavior when consolidating MCP tools.
---

Keep the advertised MCP catalog at exactly 15 registered tools. Do not append, rename, wrap, or re-index existing tools during REST or frontend enhancements.

**Why:** The user originally targeted Glama's 3–15 tool-count scoring band, then explicitly tightened the requirement to exactly 15 tools across the escrow REST and frontend requests. Those additions must not change the existing manifest.

**How to apply:** Keep REST-only and browser-only features outside MCP registration and preserve existing schemas and payment gates. Check the actual runtime tools/list count. Changing the catalog requires a new explicit user instruction; exactly 15 is a project constraint, not proof of an externally measured Glama score.