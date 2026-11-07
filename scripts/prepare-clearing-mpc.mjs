// Prepare a public starting package. This performs ZERO phase-two contributions.
// No production verification key is exported and no endpoint is armed.
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { curves, powersOfTau, zKey } from "snarkjs";
import { PHASE1 } from "./clearing-mpc/parameters.mjs";
import {
  ceremonyId,
  fileHash,
  verifyManifest,
} from "./clearing-mpc/integrity.mjs";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "generated-artifacts/clearing-mpc");
const replayPhase1 = process.argv.includes("--replay-phase1-transcript");
const trustPublished = process.argv.includes("--trust-published-phase1");
if (Number(replayPhase1) + Number(trustPublished) !== 1)
  throw new Error(
    "Choose --trust-published-phase1 (published hash pin, no local transcript replay) or --replay-phase1-transcript (potentially very expensive)",
  );
const phase1Validation = replayPhase1
  ? "full-local-snarkjs-transcript-replay"
  : "published-blake2b512-pin-only";
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
  throw new Error("Prepare the ceremony outside a live deployment");
await mkdir(out, { recursive: true, mode: 0o700 });
let exists = false;
try {
  await access(resolve(out, "manifest.json"));
  exists = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (exists) {
  const manifest = await verifyManifest(out);
  if (manifest.phase1_validation !== phase1Validation)
    throw new Error(
      "Existing starting package has a different validation scope; it will not be relabeled or rotated",
    );
  console.log(`Existing starting package verified: ${manifest.ceremony_id}`);
  process.exit(0);
}
const ptau = resolve(out, PHASE1.filename);
try {
  await access(ptau);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log(
    "Downloading public phase-one parameters from the pinned upstream source.",
  );
  const response = await fetch(PHASE1.url, {
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok || !response.body)
    throw new Error("Phase-one download failed");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024)
      throw new Error("Phase-one download exceeded limit");
    chunks.push(chunk);
  }
  await writeFile(ptau, Buffer.concat(chunks), { flag: "wx" });
}
if ((await fileHash(ptau, "blake2b512")) !== PHASE1.blake2b512) {
  await rm(ptau, { force: true });
  throw new Error("Untrusted phase-one download: checksum mismatch");
}
const compiled = spawnSync(
  "pnpm",
  [
    "exec",
    "circom2",
    "circuits/clearing_execution.circom",
    "--r1cs",
    "--wasm",
    "--sym",
    "-o",
    out,
  ],
  { cwd: root, stdio: "inherit" },
);
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
await cp(
  resolve(root, "circuits/clearing_execution.circom"),
  resolve(out, "clearing_execution.circom"),
);
await cp(
  resolve(out, "clearing_execution_js/clearing_execution.wasm"),
  resolve(out, "clearing_execution.wasm"),
);
const curve = await curves.getCurveFromName("bn128", { singleThread: true });
globalThis.curve_bn128 = curve;
try {
  if (replayPhase1) {
    console.log(
      "Replaying the public phase-one transcript. This can consume substantial CPU time.",
    );
    if (!(await powersOfTau.verify(ptau)))
      throw new Error("Phase-one verification failed");
  } else {
    console.log(
      "Published phase-one BLAKE2b-512 pin verified. Full local transcript replay NOT performed.",
    );
  }
  await zKey.newZKey(
    resolve(out, "clearing_execution.r1cs"),
    ptau,
    resolve(out, "circuit_0000.zkey"),
  );
  if (
    !(await zKey.verifyFromR1cs(
      resolve(out, "clearing_execution.r1cs"),
      ptau,
      resolve(out, "circuit_0000.zkey"),
    ))
  )
    throw new Error("Initial key/R1CS verification failed");
  const packages = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  const files = {};
  for (const name of [
    "clearing_execution.circom",
    "clearing_execution.r1cs",
    "clearing_execution.wasm",
    "circuit_0000.zkey",
    PHASE1.filename,
  ])
    files[name] = await fileHash(resolve(out, name));
  const manifest = {
    schema: "clearing-independent-mpc/v1",
    stage: "awaiting-independent-contributions",
    production_activation_allowed: false,
    required_independent_contributors: 3,
    completed_independent_contributions: 0,
    phase1: PHASE1,
    phase1_validation: phase1Validation,
    files,
    public_signals: ["task_hash", "escrow_binding"],
    statement:
      "knowledge-of-Poseidon-preimage-and-escrow-binding; NOT arbitrary execution",
    tool_versions: Object.fromEntries(
      ["circom2", "circomlib", "snarkjs"].map((name) => [
        name,
        packages.dependencies[name],
      ]),
    ),
  };
  manifest.ceremony_id = ceremonyId(manifest);
  await writeFile(
    resolve(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  await verifyManifest(out);
  console.log(`Starting package verified: ${manifest.ceremony_id}`);
  console.log(
    "Independent phase-two contributions: 0/3. NOT a production key.",
  );
} finally {
  await curve.terminate();
}
