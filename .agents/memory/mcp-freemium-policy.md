---
name: MCP freemium policy
description: User-defined boundary between free MCP sandbox capabilities and paid execution.
---

Keep exactly two free canonical sandbox capabilities: indexed height/catalog discovery and proof lifecycle/status discovery. All other canonical tools must remain paid, including the new proof.notarize tool. Do not reintroduce free pricing, mesh, or delegation control tools.

**Why:** The user requested this narrow freemium policy, not a generally free control plane.

**How to apply:** Preserve free public discovery, protocol handshakes, and HTTP price quotes. Aliases may refer to the two free capabilities without expanding the advertised canonical catalog. Agent guidance must explicitly require an L402-capable wrapper such as lnget or lightning-enable-mcp for paid execution.

Documentation and cookbooks have repeatedly drifted into calling payment.get_info, mesh.get_status or proof.attenuate free. They are paid tools; invoice-free price discovery is the HTTP cost quote (GET or POST /api/v1/cost).

**How to apply:** When a pricing table, quickstart or tool count changes, sweep docs, cookbooks, SDK READMEs and their tests together, and keep proof.notarize listed.