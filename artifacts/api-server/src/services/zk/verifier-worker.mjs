// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
// Groth16 verification on a worker thread. The pairing is synchronous CPU
// work: on the API's event loop it held every waiting request for seconds on
// a freshly booted machine. This file is copied, never bundled, so snarkjs
// stays an external runtime dependency. Jobs are verified one at a time.
import { parentPort } from "node:worker_threads";
import { curves, groth16 } from "snarkjs";

let curve;
let queue = Promise.resolve();

async function verify({ verificationKey, publicSignals, proof }) {
  // Multi-threaded curves cannot start on a worker thread, so one
  // single-threaded bn128 curve is built and kept. snarkjs's verifier reuses
  // the curve published on globalThis.curve_bn128 instead of building one.
  curve ??= await curves.getCurveFromName("bn128", { singleThread: true });
  globalThis.curve_bn128 = curve;
  return (await groth16.verify(verificationKey, publicSignals, proof)) === true;
}

parentPort.on("message", (job) => {
  queue = queue.then(async () => {
    try {
      parentPort.postMessage({ id: job.id, valid: await verify(job) });
    } catch (error) {
      parentPort.postMessage({
        id: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
