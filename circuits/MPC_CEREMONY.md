# Solo Founder Genesis Setup

## Founder declaration

> The Genesis Keys were mathematically forged by the Founder via a Single-Operator Setup to eliminate external dependencies and initiate the mainnet launch.

The production integration uses these keys for authenticated proof-and-funding
receipt settlement. Publishing this release is a separate step; automated
Lightning payouts are not enabled by this integration.

## Status and scope

The founder has selected a **single-operator Phase 2 setup**. External human
participants are not a prerequisite under this ceremony policy. This replaces
the previous independent-participant recruitment policy. The founder subsequently
authorized scoped production key loading and settlement activation, preserving
the core 16 tools, L402 gates and worker/funding authorization checks.

One actual snarkjs contribution, named **Chuck Genesis Forge**, was generated
locally and verified against the original R1CS and prepared Phase 1 parameters.
The final proving key and exported verification key are in
`generated-artifacts/solo-founder-genesis/`. Their public SHA-256 fingerprints
and verification results are recorded in `circuits/GENESIS_SETUP.json`.

The trust model is single-operator: soundness depends on the operator's setup
environment and destruction of secret contribution material. A valid transcript
does not establish secure erasure, independent participation or an external audit.
The installed snarkjs 0.7.6 mixes fresh OS randomness with the supplied public
entropy string; that string is not a private secret or a reproducible setup seed.

The unchanged circuit proves knowledge of a private Poseidon preimage and binds
the public task hash and escrow UUID. It does **not** prove arbitrary execution,
task quality, legal indemnity, trustless custody or payment.

## Inputs and Phase 1 provenance

The existing compiled inputs are:

- `generated-artifacts/clearing-mpc/clearing_execution.r1cs`
- `generated-artifacts/clearing-mpc/powersOfTau28_hez_final_12.ptau`
- `generated-artifacts/clearing-mpc/clearing_execution.wasm`

The original circuit source remains `circuits/clearing_execution.circom`.
Neither the R1CS nor the Phase 1 file is deleted or replaced by this ceremony.

The prepared bn128 power-12 parameters support 4,096 constraints and were
previously obtained from
`https://circom.info/powersOfTau28_hez_final_12.ptau`. Their BLAKE2b-512 digest
matches the snarkjs published pin:

```text
ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a
```

This is a published-checksum match, not a completed local replay of the entire
Phase 1 transcript. The existing MPC starting package and its historical
manifest remain unchanged; they are not relabeled as the solo setup.

## Phase 2 execution

The following commands were run from the workspace root using installed
snarkjs 0.7.6, without fetching a replacement package or contacting participants:

```sh
npx --no-install snarkjs groth16 setup \
  generated-artifacts/clearing-mpc/clearing_execution.r1cs \
  generated-artifacts/clearing-mpc/powersOfTau28_hez_final_12.ptau \
  generated-artifacts/solo-founder-genesis/circuit_0000.zkey

npx --no-install snarkjs zkey contribute \
  generated-artifacts/solo-founder-genesis/circuit_0000.zkey \
  generated-artifacts/solo-founder-genesis/circuit_final.zkey \
  --name="Chuck Genesis Forge" -v \
  -e="BitcoinStratigraphyAutonomousCentralBank2026"

npx --no-install snarkjs zkey export verificationkey \
  generated-artifacts/solo-founder-genesis/circuit_final.zkey \
  generated-artifacts/solo-founder-genesis/verification_key.json

npx --no-install snarkjs zkey verify \
  generated-artifacts/clearing-mpc/clearing_execution.r1cs \
  generated-artifacts/clearing-mpc/powersOfTau28_hez_final_12.ptau \
  generated-artifacts/solo-founder-genesis/circuit_final.zkey
```

Verification reported **ZKey Ok!**, including the named contribution. A fresh
synthetic proof is also checked against the exported key, including rejection
when its public escrow binding is changed. These are local cryptographic
checks, not a settlement or mainnet payment.

Do not rerun these commands over accepted keys. A new contribution rotates the
key pair and requires a new fingerprint record and matching proofs.
Setup logs and generated binaries remain outside Git and deployment images.

## Production integration boundary

**Production key integration and receipt settlement are enabled in this release.**
The running published service changes only after the owner uses Publish.

The exact exported verification key is installed at
`artifacts/api-server/src/services/zk/clearing-production/verification_key.json`.
The proving binary is retained durably in App Storage under its SHA-256 path.
Builds install it at
`artifacts/api-server/src/services/zk/clearing-production/circuit_final.zkey`
and copy both keys to `artifacts/api-server/dist/zk/clearing-production/`.
The installer verifies its pinned checksum; startup checks both installed keys
and the embedded verification-key fingerprint. Missing or mismatched keys fail
closed with no development-key fallback. Startup performs no storage download.
Large proving binaries remain outside Git and are installed during builds.

`NODE_ENV=production` or a hosted `REPLIT_DEPLOYMENT` selects the Genesis key.
The production envelope scheme is `clearing-poseidon-preimage-genesis-v1`;
the receipt signing domain is `bitcoinstratigraphy/clearing-genesis-receipt/v1`.
Creation returns the selected scheme, verification-key ID, settlement availability
and `payout_available: false`. Workers must generate matching proofs with the
final Genesis proving key and the original compiled circuit WASM.

Production settlement requires the authenticated contract worker, exact task and
escrow public signals, and original-invoice merchant funding confirmation. A
single atomic compare-and-set stores settled status and a signed receipt.
Identical retries return the same receipt; conflicting proofs cannot overwrite it.
Development proofs and keys cannot be substituted for production.

The development key and opted-in local behavior remain separate and unchanged.
The core 16 tools, L402 gates and staking balances are unchanged. Settlement here
means a funded preimage-evidence commit, not a transfer of funds: receipts state
`development_only: false`, `payout_executed: false` and
`legal_indemnity_granted: false`. Funds remain merchant-controlled, with no
automated payout or refund. The separate outbound payout lock remains in place.

## Live payout conditions

The selected payout model is a worker-supplied Lightning invoice included in
the worker's NIP-98-signed settlement request, with routing fees charged to escrow.
This still needs an implemented and verified production payout path.

The exact invoice amount plus the enforced maximum routing fee must not exceed
the funded escrow. The worker invoice, fee authorization, task, escrow and
worker identity must be bound before payout reservation. Unspent value must
remain explicitly accounted for; it cannot silently become operator revenue.

The current NWC payout request exposes an invoice and optional amount, but no
per-payment maximum routing fee. Checking actual fees **after** an irreversible
payment is not enforcement. Production activation therefore also needs a
fee-capped payout backend or a wallet capability whose fee ceiling is explicitly
supported and enforced. Do not send an unbounded payment and call it escrow-only
fee accounting.

PostgreSQL and Lightning cannot commit in one atomic transaction. The production
implementation must reserve a unique payout attempt durably before wallet I/O,
confirm its exact amount/hash and fee evidence, finalize the ledger atomically,
and retain uncertain outcomes for read-only reconciliation without another
`pay_invoice`. It must not reuse or alter the staking withdrawal ledger.

Production proof receipt settlement is enabled; automated Lightning payouts
remain disabled. No mainnet payment is made by this ceremony or its synthetic
production-profile verification checks.
