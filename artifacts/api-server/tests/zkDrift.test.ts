import assert from "node:assert/strict";
import test from "node:test";
import {
  generateDriftProof,
  verifyDriftProof,
} from "../src/services/zkDriftService.ts";

process.env.NODE_ENV = "test";

const contextHash = "0".repeat(64);
const block = {
  height: 840_000,
  hash: `${"0".repeat(63)}1`,
  bits: 0x207fffff,
};
const readBlock = async (height?: number) => {
  assert.equal(height, block.height);
  return { ...block };
};

test("generates and verifies an aligned proof; rejects tampering", async () => {
  const generated = await generateDriftProof({
    sessionContextHash: contextHash,
    blockHeight: block.height,
    entropyThreshold: 0.5,
  }, { readBlock });

  assert.equal(generated.driftScore, 0.5);
  assert.equal(generated.isAligned, true);
  assert.equal(generated.proof.circuit, "zk.drift.v1");
  assert.equal(generated.proof.publicSignals.length, 9);
  assert.equal(
    await verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.5,
      ...generated,
    }, { readBlock }),
    true,
  );
  await assert.rejects(
    verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.5,
      proof: generated.proof,
    }, {
      readBlock: async () => {
        throw new Error("Bitcoin block provider unavailable");
      },
    }),
    /Bitcoin block provider unavailable/,
  );

  const forgedSignal = structuredClone(generated.proof);
  forgedSignal.publicSignals[5] = "255";
  assert.equal(
    await verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.5,
      proof: forgedSignal,
    }, { readBlock }),
    false,
  );

  const forgedProof = structuredClone(generated.proof);
  forgedProof.pi_a[0] = (BigInt(forgedProof.pi_a[0]) + 1n).toString();
  assert.equal(
    await verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.5,
      proof: forgedProof,
    }, { readBlock }),
    false,
  );

  assert.equal(
    await verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.49,
      proof: generated.proof,
    }, { readBlock }),
    false,
  );
  assert.equal(
    await verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.5,
      proof: generated.proof,
    }, {
      readBlock: async (height) => ({
        ...block,
        height: height!,
        hash: `${"0".repeat(62)}02`,
      }),
    }),
    false,
  );
});

test("generates a non-aligned proof and rejects height mismatches", async () => {
  const generated = await generateDriftProof({
    sessionContextHash: contextHash,
    blockHeight: String(block.height),
    entropyThreshold: 0.49,
  }, { readBlock });
  assert.equal(generated.isAligned, false);
  assert.equal(generated.driftScore, 0.5);
  const defaultThreshold = await generateDriftProof({
    sessionContextHash: contextHash,
    blockHeight: block.height,
  }, { readBlock });
  assert.equal(defaultThreshold.isAligned, true);
  assert.equal(defaultThreshold.driftScore, 0.5);
  assert.equal(await verifyDriftProof({
    sessionContextHash: contextHash,
    targetBlockHeight: block.height,
    entropyThreshold: 0.85,
    ...defaultThreshold,
  }, { readBlock }), true);
  assert.equal(
    await verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.49,
      ...generated,
    }, { readBlock }),
    true,
  );
  await assert.rejects(
    verifyDriftProof({
      sessionContextHash: contextHash,
      targetBlockHeight: block.height,
      entropyThreshold: 0.49,
      proof: generated.proof,
    }, {
      readBlock: async () => ({ ...block, height: block.height + 1 }),
    }),
    /instead of requested height/,
  );
  await assert.rejects(
    generateDriftProof({
      sessionContextHash: "0x" + contextHash,
      blockHeight: block.height,
    }, { readBlock }),
    /exactly 64 hexadecimal characters/,
  );
});