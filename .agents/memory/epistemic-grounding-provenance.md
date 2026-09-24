---
name: Epistemic grounding provenance
description: Security boundary between generic attestations and Bitcoin-tip-grounded epistemic receipts.
---

Reserve the epistemic-anchor payload schema for the grounding flow; generic signing endpoints must reject it. Verify every receipt convenience field against the signed payload or proof, not only the underlying generic attestation.

**Why:** If a generic attestation endpoint can sign an epistemic-shaped payload, a caller can choose arbitrary Bitcoin state and append matching receipt aliases that appear legitimately grounded.

**How to apply:** Any new signing endpoint or receipt field must preserve domain separation, complete grounding preflight before payment redemption, and include tamper tests for both signed content and exposed aliases.

Paid MCP grounding is intended to return a directly verifiable epistemic receipt after its own settlement, not merely route callers to the separately paid HTTP endpoint.

**Why:** The user explicitly chose direct 250-sat MCP anchor creation rather than charging for a routing-only response that would demand another payment.

**How to apply:** Keep MCP and HTTP grounding as distinct payment boundaries backed by the same receipt generator; do not require a second HTTP payment to use a settled MCP receipt.