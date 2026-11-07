// Local single-operator ceremony. NEVER use these keys for production settlement.
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { curves, powersOfTau, zKey } from "snarkjs";

const root = resolve(import.meta.dirname, "..");
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
  throw new Error("Development setup must not run on a deployment");
const out = resolve(root, "generated-artifacts/clearing-development");
const keyPath = resolve(
  root,
  "artifacts/api-server/src/services/zk/clearing-development/verification_key.json",
);
await mkdir(out, { recursive: true, mode: 0o700 });
const compile = spawnSync(
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
if (compile.status !== 0) process.exit(compile.status ?? 1);
const curve = await curves.getCurveFromName("bn128", { singleThread: true });
globalThis.curve_bn128 = curve;
const file = (name) => resolve(out, name);
try {
  await powersOfTau.newAccumulator(curve, 10, file("initial.ptau"));
  // Fresh OS randomness, not a hardcoded test seed. Entropy is never logged.
  await powersOfTau.contribute(
    file("initial.ptau"),
    file("contributed.ptau"),
    "local-development-only",
    randomBytes(64).toString("hex"),
  );
  await powersOfTau.preparePhase2(
    file("contributed.ptau"),
    file("phase2.ptau"),
  );
  await zKey.newZKey(
    file("clearing_execution.r1cs"),
    file("phase2.ptau"),
    file("initial.zkey"),
  );
  await zKey.contribute(
    file("initial.zkey"),
    file("clearing_execution.zkey"),
    "local-development-only",
    randomBytes(64).toString("hex"),
  );
  if (
    !(await zKey.verifyFromR1cs(
      file("clearing_execution.r1cs"),
      file("phase2.ptau"),
      file("clearing_execution.zkey"),
    ))
  )
    throw new Error("Development setup consistency check failed");
  const vk = await zKey.exportVerificationKey(file("clearing_execution.zkey"));
  if (vk.nPublic !== 2)
    throw new Error("Unexpected clearing public signal layout");
  await mkdir(resolve(keyPath, ".."), { recursive: true });
  await writeFile(keyPath, JSON.stringify(vk, null, 2) + "\n");
  await writeFile(
    file("manifest.json"),
    JSON.stringify(
      {
        development_only: true,
        circuit_sha256: createHash("sha256")
          .update(
            await readFile(resolve(root, "circuits/clearing_execution.circom")),
          )
          .digest("hex"),
        verification_key_sha256: createHash("sha256")
          .update(JSON.stringify(vk))
          .digest("hex"),
        public_signals: ["task_hash", "escrow_binding"],
        setup: "single-operator development; not independently audited",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Development setup verified. Public key written; proving files stay in ignored generated-artifacts/.",
  );
} finally {
  for (const name of [
    "initial.ptau",
    "contributed.ptau",
    "phase2.ptau",
    "initial.zkey",
  ])
    await rm(file(name), { force: true });
  await curve.terminate();
}
