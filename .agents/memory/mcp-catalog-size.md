---
name: MCP catalog size
description: Discovery tool-count constraint and how to preserve behavior when consolidating MCP tools.
---

Preserve the original 16 core tool contracts, including `workflow.audit_trajectory`.
The user explicitly authorized the additional read-only payment utility
`payment.get_escrow`; the core plus that utility totals 17. Do not append,
rename, wrap, or re-index other tools during REST or frontend enhancements.

**Why:** The user authorized the trajectory composite as the 16th core tool and
subsequently requested staking balance lookup while expressly preserving all
16 existing tools. A separate authenticated payment utility satisfies that
request without changing the original data-tool contracts.

**How to apply:** Keep REST-only and browser-only features outside MCP registration and preserve existing schemas and payment gates. Check the actual runtime tools/list count and description integrity signatures. Further catalog changes require new explicit user instruction; catalog size is not proof of an externally measured Glama score.

Public documentation should describe **19-tool full platform capacity**:
the original core, the authenticated escrow utility, and the two host-enabled
`clearing.*` tools across six namespaces. Do not conflate full capacity with
every host's enabled catalog or claim production clearing payouts are live.

**Why:** The user requested a global documentation/marketing update to 19 tools
while protecting execution logic and retaining disabled production settlement.

**How to apply:** Put the expanded capacity prominently in README and website
copy, list both clearing tools, and preserve the distinction between optional
clearing infrastructure, the protected core, and independently evaluated grades.

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