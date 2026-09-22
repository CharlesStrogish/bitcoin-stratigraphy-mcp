---
name: Epistemic grounding provenance
description: Security boundary between generic attestations and Bitcoin-tip-grounded epistemic receipts.
---

Reserve the epistemic-anchor payload schema for the grounding flow; generic signing endpoints must reject it. Verify every receipt convenience field against the signed payload or proof, not only the underlying generic attestation.

**Why:** If a generic attestation endpoint can sign an epistemic-shaped payload, a caller can choose arbitrary Bitcoin state and append matching receipt aliases that appear legitimately grounded.

**How to apply:** Any new signing endpoint or receipt field must preserve domain separation, complete grounding preflight before payment redemption, and include tamper tests for both signed content and exposed aliases.