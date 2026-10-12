---
name: MCP catalog size
description: Discovery tool-count constraint and how to preserve behavior when consolidating MCP tools.
---

Keep the advertised MCP catalog at exactly 15 registered tools. Do not append, rename, wrap, or re-index existing tools during REST or frontend enhancements.

**Why:** The user originally targeted Glama's 3–15 tool-count scoring band, then explicitly tightened the requirement to exactly 15 tools across the escrow REST and frontend requests. Those additions must not change the existing manifest.

**How to apply:** Keep REST-only and browser-only features outside MCP registration and preserve existing schemas and payment gates. Check the actual runtime tools/list count. Changing the catalog requires a new explicit user instruction; exactly 15 is a project constraint, not proof of an externally measured Glama score.

The license-gated Python enterprise interface has an independent MCP catalog.
Do not add its tools to the original canonical catalog or remove original tools
to make room for them. Its *data source* is shared by the canonical stratigraphy
category at the user's explicit request; its separate tool catalog stays intact.

**Why:** The user requested a new FastAPI-MCP interface with one initial supply
tool without relaxing the earlier exact-15 rule for the established interface.
Keeping the catalogs separate preserves existing clients and payment policy.

**How to apply:** Share fresh licensed pipeline and cloud receipt data without
registering duplicate tools in the canonical catalog. Keep L402 and delegated
target restrictions at the canonical transport boundary.

Legacy `metrics` projection names are compatibility hints, not fields in the
live pipeline model; canonical responses currently return complete snapshots.

**Why:** Projecting legacy video-index fields onto live snapshots would invent
values or remove the power, price, horizon and provenance fields the user
requires on the primary transport.

**How to apply:** Keep the deprecation explicit. Any future projection support
must use real pipeline keys and retain the live metrics/proof envelope.