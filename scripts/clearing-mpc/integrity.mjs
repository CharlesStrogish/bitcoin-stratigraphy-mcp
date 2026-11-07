import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { PHASE1 } from "./parameters.mjs";

export async function fileHash(path, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export function ceremonyId(manifest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: manifest.schema,
        phase1: manifest.phase1,
        phase1_validation: manifest.phase1_validation,
        files: manifest.files,
        public_signals: manifest.public_signals,
        statement: manifest.statement,
        tool_versions: manifest.tool_versions,
      }),
    )
    .digest("hex");
}

/** File paths in imported manifests never escape their handoff directory. */
export async function verifyManifest(directory) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== "clearing-independent-mpc/v1" ||
    manifest.stage !== "awaiting-independent-contributions" ||
    manifest.production_activation_allowed !== false ||
    manifest.required_independent_contributors !== 3 ||
    manifest.completed_independent_contributions !== 0 ||
    ![
      "published-blake2b512-pin-only",
      "full-local-snarkjs-transcript-replay",
    ].includes(manifest.phase1_validation) ||
    JSON.stringify(manifest.public_signals) !==
      JSON.stringify(["task_hash", "escrow_binding"]) ||
    JSON.stringify(manifest.phase1) !== JSON.stringify(PHASE1) ||
    manifest.ceremony_id !== ceremonyId(manifest)
  ) {
    throw new Error("Invalid or unexpected starting ceremony manifest");
  }
  const required = [
    "clearing_execution.circom",
    "clearing_execution.r1cs",
    "clearing_execution.wasm",
    "circuit_0000.zkey",
    PHASE1.filename,
  ];
  if (
    !manifest.files ||
    JSON.stringify(Object.keys(manifest.files).sort()) !==
      JSON.stringify(required.sort())
  )
    throw new Error("Unexpected ceremony files");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (
      basename(name) !== name ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      (await fileHash(resolve(directory, name))) !== digest
    )
      throw new Error("Ceremony file checksum mismatch");
  }
  if (
    (await fileHash(resolve(directory, PHASE1.filename), "blake2b512")) !==
    PHASE1.blake2b512
  )
    throw new Error("Phase-one file differs from the pinned upstream ceremony");
  return manifest;
}
