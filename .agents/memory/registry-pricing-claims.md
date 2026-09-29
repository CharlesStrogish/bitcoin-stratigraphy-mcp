---
name: Registry pricing claims
description: Distinguish aspirational directory price labels from the live MCP payment terms.
---

Directory metadata can include the requested 10-sat / $0.001-per-call micro-metered tier only as an illustrative target, not as a promise about current charges. The free-discovery tools are genuinely free, but paid tools have different live L402 prices. Check the server's unauthenticated `payment.info` response before changing pricing claims or enabling a wallet.

**Why:** During registry preparation, live payment.info listed 250 sats for most paid calls and 10 sats only for proof.list, contradicting the requested blanket 10-sat listing text. Some x402 payment terms may be unavailable.

**How to apply:** Keep manifests and README explicit about target versus published cost; never treat a directory listing as a charge authorization or imply x402 settlement is active solely because it is tagged.