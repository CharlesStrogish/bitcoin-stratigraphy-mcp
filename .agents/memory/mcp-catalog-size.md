---
name: MCP catalog size
description: Discovery tool-count constraint and how to preserve behavior when consolidating MCP tools.
---

Keep the advertised MCP catalog at exactly 15 registered tools. Do not append, rename, wrap, or re-index existing tools during REST or frontend enhancements.

**Why:** The user originally targeted Glama's 3–15 tool-count scoring band, then explicitly tightened the requirement to exactly 15 tools across the escrow REST and frontend requests. Those additions must not change the existing manifest.

**How to apply:** Keep REST-only and browser-only features outside MCP registration and preserve existing schemas and payment gates. Check the actual runtime tools/list count. Changing the catalog requires a new explicit user instruction; exactly 15 is a project constraint, not proof of an externally measured Glama score.

The license-gated Python enterprise interface has an independent MCP catalog.
Do not fold its tools into the original canonical catalog or remove original
tools to make room for them.

**Why:** The user requested a new FastAPI-MCP interface with one initial supply
tool without relaxing the earlier exact-15 rule for the established interface.
Keeping the catalogs separate preserves existing clients and payment policy.

**How to apply:** Scope future enterprise-interface additions to that independent
transport unless the user explicitly requests a change to the canonical catalog.