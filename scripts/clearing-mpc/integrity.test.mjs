import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PHASE1 } from "./parameters.mjs";
import { ceremonyId, fileHash, verifyManifest } from "./integrity.mjs";

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

test("file hashing binds exact bytes using SHA-256 and BLAKE2b-512", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clearing-mpc-hash-test-"));
  try {
    const file = join(temporary, "fixture");
    await writeFile(file, "abc");
    assert.equal(await fileHash(file), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(await fileHash(file, "blake2b512"), createHash("blake2b512").update("abc").digest("hex"));
    await writeFile(file, "changed");
    assert.notEqual(await fileHash(file), createHash("sha256").update("abc").digest("hex"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("consistent local checksums cannot bypass the pinned upstream phase-one parameters", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clearing-mpc-pin-test-"));
  try {
    const manifest = structuredClone(original);
    for (const name of Object.keys(manifest.files)) {
      await writeFile(join(temporary, name), `synthetic unit fixture: ${name}`);
      manifest.files[name] = await fileHash(join(temporary, name));
    }
    manifest.ceremony_id = ceremonyId(manifest);
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(verifyManifest(temporary), /differs from the pinned upstream ceremony/);
    await writeFile(join(temporary, "circuit_0000.zkey"), "tampered");
    await assert.rejects(verifyManifest(temporary), /checksum mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
    join(tmpdir(), "clearing-mpc-integrity-test-"),
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
    join(tmpdir(), "clearing-mpc-integrity-test-"),
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
