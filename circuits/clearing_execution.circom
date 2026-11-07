pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// DEVELOPMENT ONLY. Knowledge of a 32-byte preimage, not arbitrary execution.
// Split the preimage into two big-endian unsigned 128-bit integers.
template ClearingExecution() {
    signal input execution_trace_preimage[2];
    signal input task_hash;
    signal input escrow_binding;

    component halves[2];
    component hash = Poseidon(2);
    for (var i = 0; i < 2; i++) {
        halves[i] = Num2Bits(128);
        halves[i].in <== execution_trace_preimage[i];
        hash.inputs[i] <== execution_trace_preimage[i];
    }
    hash.out === task_hash;

    // The UUID is a second public input. Range constraints retain its binding
    // in the R1CS, preventing reuse of the same proof for a different escrow.
    component escrow = Num2Bits(128);
    escrow.in <== escrow_binding;
}

component main {public [task_hash, escrow_binding]} = ClearingExecution();
