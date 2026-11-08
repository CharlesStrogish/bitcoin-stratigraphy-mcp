# Solo Founder Genesis Setup

## Founder declaration

> The Genesis Keys were mathematically forged by the Founder via a Single-Operator Setup to eliminate external dependencies and initiate the mainnet launch.

This declaration describes the founder's setup and launch objective, not evidence
that mainnet settlement or payouts have been activated.

## Status and scope

The founder has selected a **single-operator Phase 2 setup**. External human
participants are not a prerequisite under this ceremony policy. This replaces
the previous independent-participant recruitment policy; it does not change
backend authorization or settlement behavior.

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

**Setup complete; production installation and vault activation not performed.**

There is currently no production clearing-key loader or configured production
clearing-key destination. The backend imports only
`artifacts/api-server/src/services/zk/clearing-development/verification_key.json`
and explicitly disallows production settlement. The proving key is used by
proof generators, not read by the settlement server.

The newly exported public verification key is retained as
`circuits/solo-founder-genesis/verification_key.json` for review. It is not wired
into the backend. The active development verification key is unchanged so
existing development proofs are not silently invalidated.

Copying a key into an arbitrary directory, changing this document, or publishing
the ceremony page cannot activate the vault. The core 16 tools, L402 gates,
settlement mechanics, staking balances and payout locks remain unchanged.

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

Production settlement remains disabled. No mainnet payment is made by this
ceremony or its cryptographic verification checks.
