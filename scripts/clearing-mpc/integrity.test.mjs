import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PHASE1 } from "./parameters.mjs";
import { ceremonyId, fileHash, verifyManifest } from "./integrity.mjs";

const starting = resolve("generated-artifacts/clearing-mpc");
const original = {
  schema: "clearing-independent-mpc/v1",
  stage: "awaiting-independent-contributions",
  production_activation_allowed: false,
  required_independent_contributors: 3,
  completed_independent_contributions: 0,
  phase1: PHASE1,
  phase1_validation: "published-blake2b512-pin-only",
  files: Object.fromEntries(
    [
      "clearing_execution.circom",
      "clearing_execution.r1cs",
      "clearing_execution.wasm",
      "circuit_0000.zkey",
      PHASE1.filename,
    ].map((name) => [name, "12".repeat(32)]),
  ),
  public_signals: ["task_hash", "escrow_binding"],
  statement:
    "knowledge-of-Poseidon-preimage-and-escrow-binding; NOT arbitrary execution",
  tool_versions: { circom2: "0.2.23", circomlib: "2.0.5", snarkjs: "0.7.6" },
};
original.ceremony_id = ceremonyId(original);

test("prepared package binds phase one, circuit, R1CS, WASM and initial key", async () => {
  const result = await verifyManifest(starting);
  const recorded = JSON.parse(
    await readFile(resolve(starting, "manifest.json"), "utf8"),
  );
  assert.equal(result.ceremony_id, recorded.ceremony_id);
  assert.equal(result.ceremony_id, ceremonyId(result));
  assert.equal(result.completed_independent_contributions, 0);
  assert.equal(result.production_activation_allowed, false);
  assert.equal(
    await fileHash(resolve(starting, PHASE1.filename), "blake2b512"),
    PHASE1.blake2b512,
  );
});

test("the ceremony ID changes if any statement, toolchain or file changes", () => {
  for (const change of [
    { statement: "different-predicate" },
    { phase1_validation: "full-local-snarkjs-transcript-replay" },
    { public_signals: ["escrow_binding", "task_hash"] },
    { phase1: { ...original.phase1, power: 13 } },
    { tool_versions: { ...original.tool_versions, circomlib: "unreviewed" } },
    ...Object.keys(original.files).map((name) => ({
      files: { ...original.files, [name]: "ab".repeat(32) },
    })),
  ])
    assert.notEqual(
      ceremonyId({ ...original, ...change }),
      original.ceremony_id,
    );
});

test("rejects forged completion, production readiness and altered public parameters", async () => {
  const temporary = await mkdtemp(
    resolve("generated-artifacts/clearing-mpc-integrity-test-"),
  );
  try {
    for (const change of [
      { completed_independent_contributions: 3 },
      { required_independent_contributors: 1 },
      { production_activation_allowed: true },
      { stage: "production-ready" },
      { phase1_validation: "assumed-verified" },
      {
        phase1: {
          ...original.phase1,
          url: "https://untrusted.invalid/phase1.ptau",
        },
      },
    ]) {
      const invalid = { ...original, ...change };
      invalid.ceremony_id = ceremonyId(invalid);
      await writeFile(
        join(temporary, "manifest.json"),
        JSON.stringify(invalid),
      );
      await assert.rejects(
        verifyManifest(temporary),
        /unexpected starting ceremony/,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects manifest path traversal and changed recorded checksums", async () => {
  const temporary = await mkdtemp(
    resolve("generated-artifacts/clearing-mpc-integrity-test-"),
  );
  try {
    const invalid = {
      ...original,
      files: { ...original.files, "../escape.zkey": "00".repeat(32) },
    };
    invalid.ceremony_id = ceremonyId(invalid);
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(invalid));
    await assert.rejects(
      verifyManifest(temporary),
      /Unexpected ceremony files/,
    );
    const changed = {
      ...original,
      files: {
        ...original.files,
        "circuit_0000.zkey": "00".repeat(32),
      },
    };
    // An unchanged pinned ID cannot authorize changed files.
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(changed));
    await assert.rejects(
      verifyManifest(temporary),
      /unexpected starting ceremony/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
