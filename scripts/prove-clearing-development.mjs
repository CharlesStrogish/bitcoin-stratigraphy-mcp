// Read private witness from stdin, NEVER command-line arguments or logs.
// stdout contains ONLY public task_hash and the serialized proof envelope.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { poseidon2 } from "poseidon-lite";
import { curves, groth16 } from "snarkjs";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "generated-artifacts/clearing-development");
let curve;
try {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
    throw new Error("Not available in production");
  // A 4 KiB cap prevents accidentally buffering an unlimited private trace.
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) throw new Error("Witness too large");
    chunks.push(chunk);
  }
  const witness = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(witness.escrow_id) ||
    !/^[0-9a-f]{64}$/.test(witness.execution_trace_preimage)
  )
    throw new Error("Invalid witness encoding");
  const halves = [
    witness.execution_trace_preimage.slice(0, 32),
    witness.execution_trace_preimage.slice(32),
  ].map((h) => BigInt("0x" + h));
  const task = poseidon2(halves);
  const manifest = JSON.parse(
    await readFile(resolve(out, "manifest.json"), "utf8"),
  );
  const vk = JSON.parse(
    await readFile(
      resolve(
        root,
        "artifacts/api-server/src/services/zk/clearing-development/verification_key.json",
      ),
      "utf8",
    ),
  );
  if (
    manifest.verification_key_sha256 !==
      createHash("sha256").update(JSON.stringify(vk)).digest("hex") ||
    manifest.circuit_sha256 !==
      createHash("sha256")
        .update(
          await readFile(resolve(root, "circuits/clearing_execution.circom")),
        )
        .digest("hex")
  )
    throw new Error("Stale development artifacts");
  if (witness.task_hash !== task.toString(16).padStart(64, "0"))
    throw new Error("Witness does not match the contract task hash");
  curve = await curves.getCurveFromName("bn128", { singleThread: true });
  globalThis.curve_bn128 = curve;
  const result = await groth16.fullProve(
    {
      execution_trace_preimage: halves.map(String),
      task_hash: task.toString(),
      escrow_binding: BigInt(
        "0x" + witness.escrow_id.replaceAll("-", ""),
      ).toString(),
    },
    resolve(out, "clearing_execution_js/clearing_execution.wasm"),
    resolve(out, "clearing_execution.zkey"),
    undefined,
    undefined,
    { singleThread: true },
  );
  if (!(await groth16.verify(vk, result.publicSignals, result.proof)))
    throw new Error("Proof self-verification failed");
  process.stdout.write(
    JSON.stringify({
      task_hash: task.toString(16).padStart(64, "0"),
      execution_trace: JSON.stringify({
        scheme: "clearing-poseidon-preimage-development-v1",
        ...result,
      }),
    }) + "\n",
  );
} catch {
  process.stderr.write(
    "Development proof not generated. Check the private witness and local setup; no settlement was attempted.\n",
  );
  process.exitCode = 1;
} finally {
  await curve?.terminate();
}
