pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

template TelemetryProof() {
    signal input blockHeight;
    signal input thermodynamicHash;
    signal input timestamp;
    signal input valuationSat;
    signal input snapshotDigest;

    signal input snapshotWitnessDigest;
    signal input valuationMultiplier;

    component blockBits = Num2Bits(32);
    blockBits.in <== blockHeight;
    component timestampBits = Num2Bits(48);
    timestampBits.in <== timestamp;
    component valuationBits = Num2Bits(48);
    valuationBits.in <== valuationSat;
    component multiplierBits = Num2Bits(32);
    multiplierBits.in <== valuationMultiplier;

    component commitment = Poseidon(5);
    commitment.inputs[0] <== blockHeight;
    commitment.inputs[1] <== timestamp;
    commitment.inputs[2] <== valuationSat;
    snapshotDigest === snapshotWitnessDigest;
    commitment.inputs[3] <== snapshotWitnessDigest;
    commitment.inputs[4] <== valuationMultiplier;
    thermodynamicHash === commitment.out;

    valuationSat === valuationMultiplier * 100;
}

component main {public [blockHeight, thermodynamicHash, timestamp, valuationSat, snapshotDigest]} = TelemetryProof();