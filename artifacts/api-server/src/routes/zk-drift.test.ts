// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerZkDriftRoute } from "./zk-drift";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const hash = "ab".repeat(32);

const proofResult = {
  driftScore: 0.2,
  isAligned: true,
  targetBlockHeight: 840_001,
  proof: {
    circuit: "zk.drift.v1" as const,
    pi_a: ["1", "2", "1"],
    pi_b: [
      ["1", "2"],
      ["3", "4"],
      ["1", "0"],
    ],
    pi_c: ["5", "6", "1"],
    publicSignals: ["1", "2"],
    verificationKeyId: "zk-drift-test",
  },
  thermodynamicEntropyBits: 7,
  blockHash: "cd".repeat(32),
  compactTarget: 486604799,
};

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serve(app: ReturnType<typeof express>): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function makeApp(
  generateDriftProof: Parameters<typeof registerZkDriftRoute>[1] extends
    { generateDriftProof?: infer T } | undefined
    ? NonNullable<T>
    : never,
) {
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  registerZkDriftRoute(app, { generateDriftProof });
  return app;
}

test("POST /api/zk/drift validates input and returns the proof result", async () => {
  const calls: unknown[] = [];
  const baseUrl = await serve(
    makeApp(async (input, options) => {
      calls.push({ input, options });
      return proofResult;
    }),
  );

  const response = await fetch(`${baseUrl}/api/zk/drift`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionContextHash: hash,
      blockHeight: "840000",
      entropyThreshold: 0.9,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      input: {
        sessionContextHash: hash,
        blockHeight: "840000",
        entropyThreshold: 0.9,
      },
      options: {},
    },
  ]);
  assert.deepEqual(await response.json(), {
    ...proofResult,
    entropyInterpretation:
      "thermodynamicEntropyBits is a hash bit-balance proxy, not a physical entropy measurement.",
    proofInterpretation:
      "This proof attests the drift circuit relation against public-provider block data, not Bitcoin consensus or in-circuit proof-of-work. The Groth16 parameters come from a local single-party setup, not an independently verified ceremony.",
  });
});

test("POST /api/zk/drift rejects malformed and unknown input without invoking proof generation", async () => {
  let calls = 0;
  const baseUrl = await serve(
    makeApp(async () => {
      calls += 1;
      return proofResult;
    }),
  );
  const invalidBodies = [
    { sessionContextHash: "0x" + hash },
    { sessionContextHash: hash, blockHeight: "01" },
    { sessionContextHash: hash, blockHeight: -1 },
    { sessionContextHash: hash, blockHeight: 4_294_967_296 },
    { sessionContextHash: hash, blockHeight: "4294967296" },
    {
      sessionContextHash: hash,
      blockHeight: "999999999999999999999999999999999999999",
    },
    { sessionContextHash: hash, entropyThreshold: 1.1 },
    { sessionContextHash: hash, entropyThreshold: "0.85" },
    { sessionContextHash: hash, anotherField: true },
    { sessionContextHash: hash, extra: "x".repeat(5_000) },
    ["not", "an", "object"],
  ];

  for (const body of invalidBodies) {
    const response = await fetch(`${baseUrl}/api/zk/drift`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("latest-block requests default correctly and uint32 maximum is accepted", async () => {
  const inputs: unknown[] = [];
  const baseUrl = await serve(
    makeApp(async (input) => {
      inputs.push(input);
      return proofResult;
    }),
  );

  const latest = await fetch(`${baseUrl}/api/zk/drift`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionContextHash: hash }),
  });
  assert.equal(latest.status, 200);

  const maximumHeight = await fetch(`${baseUrl}/api/zk/drift`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionContextHash: hash,
      blockHeight: "4294967295",
    }),
  });
  assert.equal(maximumHeight.status, 200);
  assert.deepEqual(inputs, [
    { sessionContextHash: hash, entropyThreshold: 0.85 },
    {
      sessionContextHash: hash,
      blockHeight: "4294967295",
      entropyThreshold: 0.85,
    },
  ]);
});

test("provider failures return 503 and a full proof queue returns 429", async () => {
  const unavailableUrl = await serve(
    makeApp(async () => {
      throw new Error("provider offline");
    }),
  );
  const unavailable = await fetch(`${unavailableUrl}/api/zk/drift`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionContextHash: hash }),
  });
  assert.equal(unavailable.status, 503);

  const releaseProofs: Array<(value: typeof proofResult) => void> = [];
  let resolveBothStarted!: () => void;
  const bothProofsStarted = new Promise<void>((resolve) => {
    resolveBothStarted = resolve;
  });
  const queuedUrl = await serve(
    makeApp(
      () =>
        new Promise<typeof proofResult>((resolve) => {
          releaseProofs.push(resolve);
          if (releaseProofs.length === 2) resolveBothStarted();
        }),
    ),
  );
  const request = () =>
    fetch(`${queuedUrl}/api/zk/drift`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionContextHash: hash }),
    });
  const first = request();
  const second = request();
  await bothProofsStarted;
  const full = await request();
  assert.equal(full.status, 429);
  for (const releaseProof of releaseProofs) {
    releaseProof(proofResult);
  }
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test("repeated proof requests are rate limited", async () => {
  const baseUrl = await serve(makeApp(async () => proofResult));
  const request = () =>
    fetch(`${baseUrl}/api/zk/drift`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionContextHash: hash }),
    });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await request()).status, 200);
  }
  assert.equal((await request()).status, 429);
});
