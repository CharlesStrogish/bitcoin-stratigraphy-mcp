// Each independently identified participant runs this on THEIR OWN machine.
// It does not claim that three invocations on one machine are independent.
import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { curves, zKey } from "snarkjs";
import { verifyManifest, fileHash } from "./clearing-mpc/integrity.mjs";
import { PHASE1 } from "./clearing-mpc/parameters.mjs";

const [
  directory,
  inputArg,
  outputArg,
  expectedHash,
  expectedCeremonyId,
  participantName,
] = process.argv.slice(2);
if (
  !directory ||
  !inputArg ||
  !outputArg ||
  !/^[0-9a-f]{64}$/.test(expectedHash ?? "") ||
  !/^[0-9a-f]{64}$/.test(expectedCeremonyId ?? "") ||
  !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(participantName ?? "")
) {
  process.stderr.write(
    "Usage: node scripts/contribute-clearing-mpc.mjs <starting-package-dir> <input.zkey> <output.zkey> <confirmed-input-sha256> <confirmed-ceremony-id> <public-participant-name>\n",
  );
  process.exit(1);
}
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
  throw new Error(
    "Contribute on your own independent machine, not the live server",
  );
const manifest = await verifyManifest(resolve(directory));
if (manifest.ceremony_id !== expectedCeremonyId)
  throw new Error(
    "Starting package does not match the independently confirmed ceremony ID",
  );
const input = resolve(inputArg),
  output = resolve(outputArg);
if (input === output || (await fileHash(input)) !== expectedHash)
  throw new Error(
    "Contribution input does not match the independently confirmed hash",
  );
for (const path of [output, `${output}.handoff.json`]) {
  try {
    await access(path);
    throw new Error("Refusing to overwrite an existing contribution");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const curve = await curves.getCurveFromName("bn128", { singleThread: true });
globalThis.curve_bn128 = curve;
try {
  const r1cs = resolve(directory, "clearing_execution.r1cs");
  const ptau = resolve(directory, PHASE1.filename);
  if (!(await zKey.verifyFromR1cs(r1cs, ptau, input)))
    throw new Error("Incoming key does not verify for this circuit");
  // snarkjs mixes this fresh private OS randomness into its contribution.
  // It is never included in arguments, files, transcript records or logging.
  const contributionHash = await zKey.contribute(
    input,
    output,
    participantName,
    randomBytes(64).toString("hex"),
  );
  if (!(await zKey.verifyFromR1cs(r1cs, ptau, output)))
    throw new Error(
      "Contribution output failed verification; do not circulate it",
    );
  const handoff = {
    schema: "clearing-mpc-handoff/v1",
    ceremony_id: manifest.ceremony_id,
    participant_name: participantName,
    input_sha256: expectedHash,
    output_sha256: await fileHash(output),
    contribution_hash: Buffer.from(contributionHash).toString("hex"),
    independence_established: false,
    production_activation_allowed: false,
    note: "Participant identity, independence and transcript continuity require out-of-band verification.",
  };
  await writeFile(
    `${output}.handoff.json`,
    JSON.stringify(handoff, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(JSON.stringify(handoff, null, 2));
} finally {
  await curve.terminate();
}
