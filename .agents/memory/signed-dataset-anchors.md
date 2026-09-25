---
name: Signed dataset anchors
description: Cryptographic claims and verification boundaries for CID-linked Bitcoin-tip receipts.
---

CID-linked epistemic receipts are deliberately signed Bitcoin-tip anchors, not Groth16 proofs or proofs that Bitcoin proof-of-work was validated. A hash of the CID and tip is only a commitment; do not call it a ZK proof or report that such a proof was verified.

**Why:** The requested lightweight "Groth16-SHA256-PoW" payload would have been a digest labeled as a verified zero-knowledge proof. The user explicitly chose an honest signed receipt instead of that claim.

**How to apply:** Verify the original signed receipt and compare all outward-facing aliases with its signed payload. Lifecycle lookup of an issued receipt is not a replacement for cryptographic verification. A future genuine ZK/PoW claim needs a purpose-built circuit, prover, and verifier.