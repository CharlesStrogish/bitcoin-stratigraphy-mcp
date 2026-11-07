---
name: A2A clearing scaffold scope
description: User-approved fail-closed execution verification and protected core boundaries.
---

Keep the 16 Fiduciary data tools and v1.1.0 payment.get_escrow logic unchanged
when implementing clearing. Clearing contracts must be isolated from existing
staking balances and legacy escrow settlement records.

**Why:** The user explicitly imposed all three protections, including keeping
the existing regression tests passing.

**How to apply:** Mount clearing as a separate host-enabled MCP extension.
Do not change canonical data-tool handlers or use clearing funding as a data-tool
access pass.

Settlement must fail closed until a trusted execution verifier exists. Do not
reuse telemetry/drift circuits or label hashes as verified execution proofs.

**Why:** After being told that there was no task-execution circuit or trusted
verification key, the user explicitly chose “Fail-closed scaffold.”

**How to apply:** Verify the worker's real NIP-98 signature and contract ownership,
but never mark contracts settled, release money, or emit a ZK-Indemnity Receipt
without a separately specified execution circuit, task binding, and funding
verification. Make unavailable settlement and the instruction not to fund
explicit in tool metadata and responses.

For the standalone Python starter, the user subsequently explicitly requested
silent NWC funding of clearing contract creation despite fail-closed settlement.
Keep the LND data-tool payer unchanged and share the existing durable/session
spending limits rather than giving clearing an independent allowance.

**Why:** The user requested automatic NWC payment, an escrow ID result, and
graceful reporting that the execution verifier is pending, while protecting the
existing SDK data tools and payment.get_escrow.

**How to apply:** Never perform real payments in tests. Preserve signed quote,
invoice/preimage and retry checks, describe the funding/disabled-settlement
limitation, and never translate payment confirmation into settled escrow or
a ZK-Indemnity Receipt.
