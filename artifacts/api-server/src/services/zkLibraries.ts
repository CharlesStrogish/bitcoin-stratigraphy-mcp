// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
// snarkjs and poseidon-lite pull in large module graphs (ffjavascript,
// wasmcurves, worker pools) that take hundreds of milliseconds to load. They
// are imported on first use, so the API serves requests without waiting for
// them; the background verifier warm-up loads them once startup has settled.
// Both stay external to esbuild bundles (see snark worker bundling notes).
type Snarkjs = typeof import("snarkjs");
type Poseidon = typeof import("poseidon-lite");

let snarkjs: Promise<Snarkjs> | undefined;
let poseidon: Promise<Poseidon> | undefined;

export function loadSnarkjs(): Promise<Snarkjs> {
  snarkjs ??= import("snarkjs").catch((error: unknown) => {
    snarkjs = undefined;
    throw error;
  });
  return snarkjs;
}

export function loadPoseidon(): Promise<Poseidon> {
  poseidon ??= import("poseidon-lite").catch((error: unknown) => {
    poseidon = undefined;
    throw error;
  });
  return poseidon;
}
