---
name: Bilateral contract settlement trust
description: Receipt sealing, independent Bitcoin timing evidence, and financial/identity boundaries for enterprise agent agreements.
---

Contract-state settlement means mutually agreed terms plus notary anchoring.
It is not escrow, payment of the contractual price, delivery verification,
corporate KYC, or Byzantine swarm consensus.

**Why:** The requested neutral settlement layer is defined by signing and
anchoring the agreed contract state; those mechanisms do not establish the
other business or financial facts.

**How to apply:** Describe the notary fee separately from contract consideration.
Treat corporate agent names as claims unless public keys and authority were
independently enrolled by the enterprise/auditor.

Both parties must sign the original contract before a paid submission and
separately seal the complete settlement receipt after receiving OTS evidence.

**Why:** Anchoring a signed package cannot also recursively include its own
future OTS receipt. Without the second seals, receipt metadata and OTS bytes
would not be authenticated by the original contract signatures.

**How to apply:** Preserve the original receipt and use upgrades as separate
auditor evidence; never silently replace proof bytes under existing seals.
Validate against original terms and independently pinned party keys.

Offline expiry findings require independently trusted mainnet evidence and
must distinguish Bitcoin inclusion from comparison against miner-declared
block time.

**Why:** Pending calendars or a self-supplied header are not proof of canonical
Bitcoin inclusion; even a verified block timestamp is not an exact legal UTC
deadline clock.

**How to apply:** Require auditor-controlled validated-chain evidence before
confirming inclusion. Keep pending/unavailable/late states explicit and never
invent receipts in credential-free demonstrations.

An ambiguous paid call or a post-notarization key-custodian failure must not
automatically consume another batch call.

**Why:** A lost result or failed receipt seal does not imply that the service
failed to consume a prepaid quota.

**How to apply:** Reserve transaction IDs/nonces before submission, preserve
uncertain outcomes, and require durable coordination across production restarts.

Execution-escrow commitments must remain distinct from funded Lightning escrow,
task correctness, Bitcoin anchoring, and legal compliance certification.

**Why:** The requested oracle creates LOCKED contracts from a generated payment
hash without a funding-verification step. Committing submitted trace/result hashes
does not independently verify their truth. Article 12 logging requirements do not
define a universal JSON receipt standard.

**How to apply:** Describe the dynamic protocol toll (pegged to ~$0.02 USD in satoshis) as a ledger reservation until collection
is verified. Require trusted execution acceptance and funding checks before any
public redemption integration. Never invent a strata height or call a local
receipt Bitcoin inclusion. Permission-restricted SQLite is not air-gapped or
encrypted custody.

L402 access payment must not itself authorize execution-escrow preimage release.

**Why:** Any paying client could otherwise settle or inspect another party's
contract. Access fees, contract funding, task acceptance, and custody authority
are separate trust decisions.

**How to apply:** Keep public redemption closed without independently bound
party identity and acceptance. Operator-only REST access is intentional until
those checks exist; do not remove it merely to make browser calls easier.
