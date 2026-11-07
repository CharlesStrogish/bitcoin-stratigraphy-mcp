# Clearing execution circuit — LOCAL DEVELOPMENT ONLY

This implements the approved **local development setup**, not production
activation. No existing data-tool handler, price, payment path, or Python SDK
distribution is changed.

## What is proved

`clearing_execution.circom` proves knowledge of a 32-byte private preimage whose
two big-endian, unsigned 128-bit halves hash with circomlib `Poseidon(2)` to
`task_hash`. Both halves are range-constrained; they cannot alias larger field
values. `task_hash` is the canonical 64-character lowercase hex encoding of the
Poseidon field element, **not SHA-256 and not a SHA-256 digest reduced modulo Fr**.
Existing contracts containing arbitrary SHA-256 task hashes are not converted.

The public signals, in order, are:

1. `task_hash`, canonical unsigned decimal, less than BN254's scalar modulus.
2. `escrow_binding`, the escrow UUID with hyphens removed, interpreted as a
   big-endian unsigned 128-bit integer and encoded as canonical decimal.

The second signal is constrained in the circuit. Changing the UUID in an
existing proof or submitting it for another escrow fails verification.

This proves **preimage knowledge**, not arbitrary computation, task quality,
legal indemnity, Lightning custody, payout, or fully trustless A2A execution.
NIP-98 authentication and merchant funding confirmation remain separate
server-side checks. PostgreSQL and the operator remain trusted.

## Compile and create development keys

From the workspace root, with the existing pinned dependencies installed:

```sh
node scripts/setup-clearing-development.mjs
```

This compiles the circuit using `circom2`, runs fresh single-operator phase-one
and phase-two contributions using OS randomness, verifies zkey/R1CS consistency,
and exports:

- Public key: `artifacts/api-server/src/services/zk/clearing-development/verification_key.json`.
- Ignored local proving artifacts: `generated-artifacts/clearing-development/`.
- Local manifest: circuit source SHA-256, verification-key SHA-256, signal layout
  and explicit development-only trust status.

Intermediate ceremony files are removed. Entropy is never logged or committed.
This is **not an independently audited multiparty ceremony**. The small public
verification key is committed; proving files and build outputs are neither
committed nor included in published images.

**Rerunning setup rotates the development key.** Rebuild/restart the development
API afterward and generate matching new proofs. Do not regenerate it casually
for existing development contracts. A fresh checkout must run setup before the
integration test; that intentionally generates a new local key and updates the
tracked public key. No network download or production credentials are required
for the ceremony.

## Local opt-in

The API requires both `NODE_ENV=development` (or `test`) and
`CLEARING_DEVELOPMENT_SETTLEMENT=1` in its own process configuration.
The flag defaults off. It **cannot enable settlement with
`NODE_ENV=production` or `REPLIT_DEPLOYMENT` set**, even if the flag is `1`.
Do not enable it against real custody or a live merchant wallet.

Creation preserves its exact NIP-98 body/request binding and invoice reservation
before wallet I/O. In local mode:

1. The worker signs the exact settlement URL, method and request body with
   fresh NIP-98; the server checks the contract's worker and revocation status.
2. The server checks the exact two public signals and verifies the actual
   Groth16 proof off-thread using only the dedicated clearing key.
3. The server checks the original invoice through its original merchant provider,
   with the exact payment hash, amount, asset, and contract/task description.
   No worker-supplied “paid” flag, payment preimage, or replacement invoice is used.
4. A single conditional PostgreSQL update persists `settled`, `settled_at`,
   the proof digest, and the signed receipt together. It checks the immutable
   contract snapshot. Concurrent identical requests return the same stored
   receipt; a conflicting proof does not overwrite it.

An already committed identical request returns its historical receipt without a
new payment lookup. Disabling the development gate blocks settlement, including
receipt replay. No money is sent, refunded, unlocked, or credited to staking.
An expired invoice is not automatically replaced; a confirmed historical
payment is not rejected simply because the invoice has since expired.

The portable receipt signs:

```text
bitcoinstratigraphy/clearing-development-receipt/v1\n
```

followed immediately by the exact UTF-8 bytes of its `payload` string, using the
existing independently pinned **payload** Ed25519 identity, not the manifest or
webhook identity. Its `key_id` is SHA-256 of the public SPKI DER. The payload
states `development_only: true`, `guarantee: "knowledge-of-hash-preimage"`,
`legal_indemnity_granted: false` and `payout_executed: false`. It binds buyer,
worker, escrow, task, amount, payment hash/provider, funding time, proof digest,
verification-key fingerprint and settlement time.

## Worker proof generation

Prepare the Poseidon task hash before creating the contract. For example,
`poseidon-lite`'s `poseidon2([first128Bits, second128Bits])` matches this circuit.
Never use a public or predictable preimage for a meaningful contract.

After obtaining the escrow UUID, feed a private JSON object on **stdin** to:

```sh
node scripts/prove-clearing-development.mjs < /path/to/private-witness.json
```

The object contains `escrow_id`, `task_hash` and `execution_trace_preimage`
(64 lowercase hex characters). Do not place secrets in shell command arguments
or commit the witness file. The helper checks the manifest and expected task,
generates and self-verifies a real Groth16 proof, and outputs only `task_hash`
and the public `execution_trace` string. Send that string using the worker's
`ClearingTools.settle_contract(escrow_id, execution_trace)`.

The starter checks both the exact HTTP response attestation and the portable
receipt against its independently configured payload-key pin. It also checks
worker, escrow, task, proof digest and the development-only guarantee. The
starter does not independently re-run Groth16; a pinned server signature is
still an operator attestation, not removal of operator trust.

## Dedicated tests

```sh
node scripts/test-clearing-development.mjs
```

This uses actual local proof generation, actual off-thread verification, HTTP
NIP-98 authentication and actual PostgreSQL writes. It creates and drops a
random isolated PostgreSQL schema containing only `clearing_contracts`; no
existing tables or rows are used. Merchant responses, invoices and identities
are synthetic. It never imports or calls the 16 core data tools, contacts a
wallet/relay, or sends mainnet funds.

The normal development PostgreSQL connection must be available. The test
runner refuses production/deployment mode. It does not run the repository-wide
test command or the core SDK suite.

Starter-only mocks:

```sh
cd starter-swarm-python
python -m unittest -v test_clearing.py test_clearing_receipts.py
```

Existing test files and their assertions are preserved. The broader 136-test
baseline includes protected data-tool tests and is deliberately not rerun by
these commands.

## Before any production activation

Production remains fail-closed. A separate reviewed change must establish the
actual execution predicate and task format, independently verified ceremony
artifacts for that exact circuit, key lifecycle policy, custody and payout
semantics, and production verification. Do not promote this local key, receipt
label, or a passing development integration test as those guarantees.
