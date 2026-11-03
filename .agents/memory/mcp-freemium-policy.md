---
name: MCP freemium policy
description: User-defined boundary between free MCP sandbox capabilities and paid execution.
---

Keep exactly two permanently free canonical sandbox capabilities: indexed height/catalog discovery and proof lifecycle/status discovery. Other tools retain paid prices, with the user-authorized Genesis Grant exception for the first ten authenticated NIP-98 individual tool executions per pubkey. Do not reintroduce permanently free pricing, mesh, or delegation control tools.

**Why:** The user requested this narrow freemium policy and later explicitly authorized a ten-call lifetime Genesis Grant to eliminate cold-start wallet friction, not a generally free control plane.

**How to apply:** Preserve free public discovery, protocol handshakes, and HTTP price quotes. Aliases may refer to the two free capabilities without expanding the advertised canonical catalog. Agent guidance must require an L402-capable wrapper for paid execution after the Genesis Grant is exhausted; the grant does not remove the paid tool catalog or expand it.

Keep PostgreSQL persistence and refunds for definitively failed grant executions.

**Why:** The user explicitly approved “The PostgreSQL persistence and the failure refund logic.”

**How to apply:** Preserve both properties when revising grant accounting or deployment setup.

Documentation and cookbooks have repeatedly drifted into calling payment.get_info, mesh.get_status or proof.attenuate free. They are paid tools; invoice-free price discovery is the HTTP cost quote (GET or POST /api/v1/cost).

**How to apply:** When a pricing table, quickstart or tool count changes, sweep docs, cookbooks, SDK READMEs and their tests together, and keep proof.notarize listed.