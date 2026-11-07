---
name: A2A clearing trust boundaries
description: Development-only preimage proofs, production fail-closed settlement and protected core boundaries.
---

Keep the 16 Fiduciary data tools and v1.1.0 payment.get_escrow logic unchanged
when implementing clearing. Clearing contracts must be isolated from existing
staking balances and legacy escrow settlement records.
Do not run tests against the 16 core data tools when working on clearing.

**Why:** The user explicitly imposed all three protections, including keeping
the existing regression tests passing.

**How to apply:** Mount clearing as a separate host-enabled MCP extension.
Do not change canonical data-tool handlers or use clearing funding as a data-tool
access pass.

Production settlement must fail closed until a trusted execution verifier exists. Do not
reuse telemetry/drift circuits or label hashes as verified execution proofs.

**Why:** After being told that there was no task-execution circuit or trusted
verification key, the user explicitly chose “Fail-closed scaffold.”

**How to apply:** Verify the worker's real NIP-98 signature and contract ownership,
but never mark production contracts settled, release money, or emit a production ZK-Indemnity Receipt
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

The user approved a local development Groth16 setup after being told that a
hash-preimage circuit does not prove arbitrary task execution and a locally
generated key is not an independently established production trust basis.
Local development may record funded, authenticated preimage-proof settlement
and a signed development receipt. Production remains disabled.

**Why:** The user explicitly selected “Local development setup” rather than
audited production activation.

**How to apply:** Keep development keys and activation separate from production.
Require the contract's worker identity, exact task/escrow proof binding and
merchant funding confirmation. Describe receipts as preimage-knowledge evidence,
not arbitrary execution, legal indemnity, payouts or fully trustless custody.
Never run tests against the 16 core data tools for clearing work; preserve the
existing regression assertions rather than weakening them.
