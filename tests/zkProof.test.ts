import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  generateZkProof,
  prewarmZkVerifier,
  shutdownZkVerifier,
  verifyZkProof,
  verifyZkProofForSnapshot,
} from "../artifacts/api-server/src/services/zkProofService";

async function sampleProof() {
  return generateZkProof({
    snapshot: {
      observed_at: "2026-09-16T12:00:00.000Z",
      block: { height: 920_000 },
      thermodynamic: { signal: "elevated-target-distance", target_multiplier: 110 },
    },
    blockHeight: 920_000,
    timestamp: Date.UTC(2026, 8, 16, 12),
    valuationMultiplier: 110,
  });
}

test("generates and verifies a Groth16 telemetry proof", async () => {
  const payload = await sampleProof();
  assert.match(payload.proof, /^[A-Za-z0-9_-]+$/);
  assert.equal(payload.publicInputs.blockHeight, 920_000);
  assert.equal(payload.publicInputs.valuationSat, 11_000_000_000);
  assert.equal(await verifyZkProof(payload), true);
});

test("rejects proof and public-input tampering", async () => {
  const payload = await sampleProof();
  const tamperedProof = {
    ...payload,
    proof: `${payload.proof.slice(0, -1)}${payload.proof.endsWith("A") ? "B" : "A"}`,
  };
  assert.equal(await verifyZkProof(tamperedProof), false);
  assert.equal(
    await verifyZkProof({
      ...payload,
      publicInputs: {
        ...payload.publicInputs,
        blockHeight: payload.publicInputs.blockHeight + 1,
      },
    }),
    false,
  );
});

test("rejects payload tampering with an unchanged proof", async () => {
  const snapshot = {
    observed_at: "2026-09-16T12:00:00.000Z",
    block: { height: 920_000 },
    thermodynamic: {
      signal: "elevated-target-distance",
      target_multiplier: 110,
    },
  };
  const payload = await generateZkProof({
    snapshot,
    blockHeight: 920_000,
    timestamp: Date.UTC(2026, 8, 16, 12),
    valuationMultiplier: 110,
  });
  assert.equal(await verifyZkProofForSnapshot(payload, snapshot), true);
  assert.equal(
    await verifyZkProofForSnapshot(payload, {
      ...snapshot,
      thermodynamic: {
        ...snapshot.thermodynamic,
        target_multiplier: 111,
      },
    }),
    false,
  );
});

test("verifies paid arrays with reused attestation timestamps", async () => {
  const snapshot = [
    {
      quantitative_alpha: { target_multiplier: 100 },
      attestation: { event: { created_at: 1_789_646_400 } },
    },
    {
      quantitative_alpha: { target_multiplier: 110 },
      attestation: { event: { created_at: 1_789_646_405 } },
    },
  ];
  const payload = await generateZkProof({
    snapshot,
    blockHeight: 0,
    timestamp: 1_789_646_405_000,
    valuationMultiplier: 110,
  });
  assert.equal(await verifyZkProofForSnapshot(payload, snapshot), true);
});

test("rejects a proof signed for another verification key", async () => {
  const payload = await sampleProof();
  assert.equal(
    await verifyZkProof({
      ...payload,
      verificationKeyId: "zk-telemetry-v1-not-the-active-key",
    }),
    false,
  );
});

test("warmed verification averages under 10ms", async () => {
  const payload = await sampleProof();
  assert.equal(await verifyZkProof(payload), true);
  const durations: number[] = [];
  for (let index = 0; index < 25; index += 1) {
    const startedAt = performance.now();
    assert.equal(await verifyZkProof(payload), true);
    durations.push(performance.now() - startedAt);
  }
  const average = durations.reduce((total, value) => total + value, 0) /
    durations.length;
  assert.ok(average < 10, `warmed verification averaged ${average.toFixed(3)}ms`);
});

test("first verification after startup pre-warm completes under 10ms", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    await prewarmZkVerifier();
    const snapshot = {
      observed_at: "2026-09-16T12:01:00.000Z",
      block: { height: 920_001 },
      thermodynamic: {
        signal: "elevated-target-distance",
        target_multiplier: 111,
      },
    };
    const payload = await generateZkProof({
      snapshot,
      blockHeight: 920_001,
      timestamp: Date.UTC(2026, 8, 16, 12, 1),
      valuationMultiplier: 111,
    });
    const startedAt = performance.now();
    assert.equal(await verifyZkProof(payload), true);
    const duration = performance.now() - startedAt;
    assert.ok(duration < 10, `first warmed verification took ${duration.toFixed(3)}ms`);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    await shutdownZkVerifier();
  }
});