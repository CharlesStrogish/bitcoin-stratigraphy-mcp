---
name: A2A clearing trust boundaries
description: Independent production setup, worker-invoice payouts, escrow-funded fees and protected core boundaries.
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

For production activation, the user subsequently required independent
participant contributions rather than a single-operator simulation. Use at
least three actual independent phase-two contributors; different names or
invocations by this agent are not substitutes.

**Why:** After the distinction was explained, the user selected “Independent
participant contributions.”

**How to apply:** Authenticate participants and their public handoffs outside
the ceremony coordinator's own claims. Do not label an uncontributed initial
key, simulated contributions or development keys as the accepted production
ceremony. Require the real verified contribution chain before activation.

Production workers supply Lightning payout invoices in their NIP-98-signed
settlement requests. Routing fees come from the escrow balance, not additional
operator funds or existing staking balances.

**Why:** The user selected “Worker-signed Lightning invoice” and “Escrow balance”
when asked to authorize the payout and fee model.

**How to apply:** Bind destination, principal and fee authorization to the exact
worker and contract. Enforce principal plus maximum routing fee within funded
escrow before sending; observing excess fees afterward is not enforcement.
Keep unknown outbound results reserved and reconcile without sending again.

Clearing's fee-cap policy is 1% of funded escrow, rounded down to whole sats,
further capped by escrow headroom after the invoice principal. Account for
actual fees in millisatoshis; leave unused fee allowance in the escrow.

**Why:** The user requested mathematical reserve protection against routing-fee
spikes, with all business costs borne by the contract escrow. The implemented
policy uses the user's suggested 1% cap without permitting operator subsidy.

**How to apply:** Reject over-cap estimates before sending, but rely on LND's
explicit send-time fee limit for stale-estimate protection. Reserve principal
plus the maximum fee durably before I/O. Never enable production payouts merely
because keys or wallet credentials have been installed.

The user subsequently selected “Keep payouts disabled.” Ceremony preparation
or successful key verification is not permission to enable real-money routing.

**Why:** The user explicitly chose to keep payouts disabled when asked which
fee-capped payout backend to support.

**How to apply:** Preserve the live payout lock while preparing public ceremony
materials. Do not silently activate production or run real payment tests.

Distinguish an upstream-published phase-one checksum match from a completed
local cryptographic transcript replay. Do not relabel one as the other.

**Why:** A full replay of the public phase-one transcript consumed more than
11 minutes of CPU without completion and was stopped. Expensive replay must
be explicit, not an unbounded automatic step.

**How to apply:** Record the actual validation scope in ceremony metadata and
its commitment. Reusing hash-pinned public parameters must not imply that the
entire transcript was independently replayed locally or authorize activation.
