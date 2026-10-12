---
name: Escrow affordability
description: Business reason for USD-normalized autonomous escrow tolls.
---

Autonomous escrow settlement tolls should target a small USD-equivalent cost, rather than remain fixed in satoshis as Bitcoin appreciates.

**Why:** The user requires that agents not be priced out during rapid Bitcoin market appreciation.

**How to apply:** Preserve this affordability goal when revising escrow pricing. Do not substitute load/scarcity pricing for USD normalization, or conflate the contract settlement toll with the separate fee for REST API access.

Require live NWC-confirmed Lightning toll settlement before releasing escrow execution JSON or the private escrow preimage. Bind the paid capability to the exact contract, trace and result, and use the contract's reserved toll rather than a newer preview.

**Why:** The user requires transition from simulated escrow execution to real Lightning settlement at the exact evaluated protocol toll.

**How to apply:** Creation and receipt access fees remain separate. Settlement charges only the reserved toll, replacing its former fixed access fee to avoid charging more than the advertised toll. Never equate toll payment with bounty funding, Bitcoin anchoring or legal certification. Remove awaiting-confirmation status only after a real server-confirmed settlement; independent synthetic swarm demonstrations remain labeled.
