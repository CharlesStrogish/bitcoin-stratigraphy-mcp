# Independent clearing Groth16 ceremony

## Status and scope

This ceremony requires **at least three actual independent phase-two
contributors**. Three names, signing keys, processes or invocations on the
coordinator's machine are not three independent participants. No phase-two
contributions are simulated by the coordinator.

The preparation tool creates only an **UNFINALIZED starting package**. Its
`circuit_0000.zkey` is not safe to use as a production proving key. It is not
installed into the API. Existing development keys, the 35 clearing tests, all
16 Fiduciary data tools and `payment.get_escrow` remain unchanged.

The circuit proves knowledge of the private Poseidon preimage and binds the
public task hash and escrow UUID. Independent setup does not expand this into
proof of arbitrary execution, legal indemnity, trustless custody or proof of
payment.

## Phase one and initial circuit key

Run from the repository root:

```sh
node scripts/prepare-clearing-mpc.mjs --trust-published-phase1
```

This:

1. Downloads the upstream prepared bn128 power-12 file, supporting 4,096
   constraints, from
   `https://circom.info/powersOfTau28_hez_final_12.ptau`.
2. Checks its BLAKE2b-512 digest against snarkjs's published hash table:
   `ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a`.
3. Records `published-blake2b512-pin-only` in the manifest. This identifies the
   exact upstream public parameters; it does **not** claim that their full
   transcript was replayed locally.
4. Compiles the unchanged clearing circuit to R1CS and WASM using the existing
   pinned toolchain.
5. Runs the equivalent of `snarkjs groth16 setup`, then verifies initial-key
   consistency against the R1CS and pinned phase-one parameters.
6. Writes a checksummed starting manifest. It explicitly records **0/3**
   independent phase-two contributions and forbids production activation.

Files are in `generated-artifacts/clearing-mpc/`, which is ignored by Git and
excluded from deployments. An existing complete starting package is verified
and reused, not silently rotated. Failed preparation never installs a key or
arms a payout.

To explicitly request a full local transcript replay instead, use
`--replay-phase1-transcript`. The distinction is included in the ceremony ID;
an existing hash-pinned package is never silently relabeled as fully replayed.
The full replay is CPU intensive: an initial attempt here was stopped after
more than 11 minutes without completion. Do not start it as an automatic
startup task or treat a stopped replay as successful. An independent verifier
can also run `snarkjs powersoftau verify` directly against the pinned file.

Reference: <https://github.com/iden3/snarkjs#7-prepare-phase-2>.

## Independent participant handoff

The owner first identifies three independent participants and verifies their
public signing identities through a separate trusted channel. Do not upload
private signing keys, entropy, wallet credentials, witness preimages or toxic
waste to the coordinator. Names and hashes alone do not authenticate identity
or demonstrate independence.

Each participant must use their own trusted machine, a reviewed copy of the
tooling and fresh private entropy. A disposable environment without command
recording, memory dumps or shared entropy backups is recommended. JavaScript
cannot promise secure erasure of every in-memory copy; stop and dispose of the
contribution environment after the handoff.

Contributions are **sequential**, not parallel:

| Participant | Receives                     | Produces            |
| ----------- | ---------------------------- | ------------------- |
| 1           | `circuit_0000.zkey`          | `circuit_0001.zkey` |
| 2           | verified `circuit_0001.zkey` | `circuit_0002.zkey` |
| 3           | verified `circuit_0002.zkey` | `circuit_0003.zkey` |

Each participant receives the same starting manifest, original initial key,
R1CS, WASM and phase-one file. They independently confirm both the ceremony ID
and incoming key's SHA-256 through the established trusted channel.

Example, with public hashes supplied as arguments:

```sh
node scripts/contribute-clearing-mpc.mjs \
  /path/to/starting-package \
  /path/to/circuit_0000.zkey \
  /path/to/circuit_0001.zkey \
  CONFIRMED_INPUT_SHA256 \
  CONFIRMED_CEREMONY_ID \
  "PUBLIC PARTICIPANT NAME"
```

The helper checks the manifest, file hashes, public parameters and incoming
key/R1CS consistency before contributing. It generates fresh private OS
randomness directly in memory—not through shell arguments or logged entropy.
It verifies the resulting key and writes a **public** `.handoff.json` containing
the ceremony ID, incoming/outgoing SHA-256 values and snarkjs contribution hash.
It refuses to overwrite an existing contribution.

The helper does **not** claim to establish identity, independence, final
transcript continuity or production readiness. Each contributor must authenticate
their handoff record with their independently pinned public signing identity
(for example, an existing detached signature) and transmit the new key, record
and public signature. Private keys stay with the contributor.

Before accepting the next step, the coordinator and next participant must verify
the detached signature, confirm the signer out of band, check incoming/outgoing
hash continuity, and inspect the native snarkjs transcript. In particular, the
new key must retain every prior contribution fingerprint in the original order;
“verifies against this R1CS” alone does not establish that it extends the accepted
chain. A copied, renamed, restarted or unrelated key is not a new accepted step.

Native transcript verification:

```sh
pnpm exec snarkjs zkey verify \
  /path/to/starting-package/clearing_execution.r1cs \
  /path/to/starting-package/powersOfTau28_hez_final_12.ptau \
  /path/to/circuit_0003.zkey
```

## Finalization is deliberately not automatic

The three authenticated independent contributions do not exist in this workspace
yet. The coordinator must not generate replacements on their behalf.

After receiving them, verification must establish:

- The pinned phase-one parameters, exact circuit/R1CS and public-signal layout.
- At least three independently confirmed participants and distinct genuine
  snarkjs contributions, with an intact ordered transcript and signed handoffs.
- Valid final zkey/R1CS consistency, matching exported verification key, and a
  freshly generated proof verified against that final key.
- Correct new-key integration without silently changing any existing test
  assertions or modifying protected tool or staking logic.

Only then may the **final**, public proving key and verification key be exported
to the requested `circuits/` production location. Large binary artifacts must
stay out of Git/deployment history; their storage and distribution must retain
verified public checksums. Never rename the initial key to `final` or use the
existing single-operator development key as a substitute.

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

Until independent setup and this payout path are complete, production settlement
stays disabled. No mainnet payment is made by ceremony or regression tests.
