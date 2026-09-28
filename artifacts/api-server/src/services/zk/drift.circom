pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template Popcount256() {
    signal input bits[256];
    signal output count;
    var total = 0;
    for (var i = 0; i < 256; i++) {
        bits[i] * (bits[i] - 1) === 0;
        total += bits[i];
    }
    count <== total;
}

template LeadingZeros256() {
    signal input bits[256]; // little-endian
    signal output count;
    signal active[257];
    signal runningCount[257];
    active[0] <== 1;
    runningCount[0] <== 0;
    for (var i = 0; i < 256; i++) {
        var bitIndex = 255 - i;
        runningCount[i + 1] <== runningCount[i]
            + active[i] * (1 - bits[bitIndex]);
        active[i + 1] <== active[i] * (1 - bits[bitIndex]);
    }
    count <== runningCount[256];
}

template Drift() {
    // These are the externally verifiable block-derived and metric values.
    signal input blockLow;
    signal input blockHigh;
    signal input blockHeight;
    signal input targetZeroBits;
    signal input thresholdUnits;
    signal input driftUnits;
    signal input entropyBits;
    signal input isAligned;
    signal output contextCommitment;

    signal input contextLow;
    signal input contextHigh;

    component contextLowBits = Num2Bits(128);
    component contextHighBits = Num2Bits(128);
    contextLowBits.in <== contextLow;
    contextHighBits.in <== contextHigh;

    component blockLowBits = Num2Bits(128);
    component blockHighBits = Num2Bits(128);
    blockLowBits.in <== blockLow;
    blockHighBits.in <== blockHigh;

    signal contextBits[256];
    signal blockBits[256];
    for (var i = 0; i < 128; i++) {
        contextBits[i] <== contextLowBits.out[i];
        contextBits[i + 128] <== contextHighBits.out[i];
        blockBits[i] <== blockLowBits.out[i];
        blockBits[i + 128] <== blockHighBits.out[i];
    }

    component contextHash = Poseidon(2);
    contextHash.inputs[0] <== contextLow;
    contextHash.inputs[1] <== contextHigh;
    contextCommitment <== contextHash.out;

    component contextPopcount = Popcount256();
    component blockPopcount = Popcount256();
    component contextZeros = LeadingZeros256();
    contextPopcount.bits <== contextBits;
    blockPopcount.bits <== blockBits;
    contextZeros.bits <== contextBits;

    component contextCountRange = Num2Bits(9);
    component blockCountRange = Num2Bits(9);
    component contextZeroRange = Num2Bits(9);
    component targetZeroRange = Num2Bits(9);
    component thresholdRange = Num2Bits(10);
    component driftRange = Num2Bits(10);
    component entropyRange = Num2Bits(9);
    component heightRange = Num2Bits(32);
    contextCountRange.in <== contextPopcount.count;
    blockCountRange.in <== blockPopcount.count;
    contextZeroRange.in <== contextZeros.count;
    targetZeroRange.in <== targetZeroBits;
    thresholdRange.in <== thresholdUnits;
    driftRange.in <== driftUnits;
    entropyRange.in <== entropyBits;
    heightRange.in <== blockHeight;

    // Absolute differences are selected from the two range-constrained directions.
    component onesLess = LessThan(9);
    onesLess.in[0] <== contextPopcount.count;
    onesLess.in[1] <== blockPopcount.count;
    signal onesSignedDifference;
    signal onesDifference;
    onesSignedDifference <== contextPopcount.count - blockPopcount.count;
    onesDifference <== onesSignedDifference
        - onesLess.out * (2 * onesSignedDifference);

    component zerosLess = LessThan(9);
    zerosLess.in[0] <== contextZeros.count;
    zerosLess.in[1] <== targetZeroBits;
    signal zerosSignedDifference;
    signal zerosDifference;
    zerosSignedDifference <== contextZeros.count - targetZeroBits;
    zerosDifference <== zerosSignedDifference
        - zerosLess.out * (2 * zerosSignedDifference);

    driftUnits === onesDifference + zerosDifference;

    component complementOnes = LessThan(9);
    complementOnes.in[0] <== contextPopcount.count;
    complementOnes.in[1] <== 256 - contextPopcount.count;
    signal minOnes;
    minOnes <== (256 - contextPopcount.count) - complementOnes.out
        * (256 - 2 * contextPopcount.count);
    entropyBits === 2 * minOnes;

    component thresholdBelowDrift = LessThan(10);
    thresholdBelowDrift.in[0] <== thresholdUnits;
    thresholdBelowDrift.in[1] <== driftUnits;
    isAligned === 1 - thresholdBelowDrift.out;
    isAligned * (isAligned - 1) === 0;
}

component main {public [
    blockLow,
    blockHigh,
    blockHeight,
    targetZeroBits,
    thresholdUnits,
    driftUnits,
    entropyBits,
    isAligned
]} = Drift();