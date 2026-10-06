import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

export const notarizeInputSchema = z
  .object({
    hash: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .transform((hash) => hash.toLowerCase()),
  })
  .strict();

export type NotarizationReceipt = {
  hash: string;
  otsProofHex: string;
  otsStatus: "pending_calendar";
};

const run = promisify(execFile);
const MAX_PROOF_BYTES = 512 * 1024;
let activeWorkers = 0;

// Use the official Python library already declared in pyproject.toml.
// Construct from the submitted digest: hashing the digest bytes again would
// timestamp a different statement. Randomize calendar submissions for privacy.
const worker = String.raw`
import concurrent.futures
import json
import os
import sys
from opentimestamps.calendar import RemoteCalendar
from opentimestamps.core.op import OpSHA256, OpAppend
from opentimestamps.core.serialize import BytesSerializationContext, BytesDeserializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

digest = bytes.fromhex(sys.argv[1])
if len(digest) != 32:
    raise ValueError("Expected a SHA256 digest")
receipt = DetachedTimestampFile(OpSHA256(), Timestamp(digest))
commitment = receipt.timestamp.ops.add(OpAppend(os.urandom(16))).ops.add(OpSHA256())
calendars = [
    "https://a.pool.opentimestamps.org",
    "https://b.pool.opentimestamps.org",
    "https://a.pool.eternitywall.com",
]
accepted = 0
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    futures = [executor.submit(RemoteCalendar(url).submit, commitment.msg, timeout=5) for url in calendars]
    for future in concurrent.futures.as_completed(futures):
        try:
            stamp = future.result()
            if not any(stamp.all_attestations()):
                continue
            commitment.merge(stamp)
            accepted += 1
        except Exception:
            continue
if accepted == 0:
    raise RuntimeError("No OpenTimestamps calendar accepted the commitment")
context = BytesSerializationContext()
receipt.serialize(context)
proof = context.getbytes()
if not 0 < len(proof) <= 512 * 1024:
    raise RuntimeError("Invalid receipt size")
decoded = DetachedTimestampFile.deserialize(BytesDeserializationContext(proof))
if decoded.timestamp.msg != digest:
    raise RuntimeError("Receipt digest mismatch")
print(json.dumps({"hash": digest.hex(), "otsProofHex": proof.hex(), "otsStatus": "pending_calendar"}))
`;

export async function notarizeHash(hash: string): Promise<NotarizationReceipt> {
  const input = notarizeInputSchema.parse({ hash });
  if (activeWorkers >= 16)
    throw new Error("OpenTimestamps notary is busy; retry later");
  activeWorkers++;
  try {
    const { stdout } = await run("python3", ["-c", worker, input.hash], {
      timeout: 20_000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_PROOF_BYTES * 2 + 4096,
      encoding: "utf8",
    });
    const result = JSON.parse(stdout) as NotarizationReceipt;
    if (
      result.hash !== input.hash ||
      result.otsStatus !== "pending_calendar" ||
      typeof result.otsProofHex !== "string" ||
      !/^(?:[0-9a-f]{2})+$/.test(result.otsProofHex) ||
      result.otsProofHex.length > MAX_PROOF_BYTES * 2
    ) {
      throw new Error("Invalid OpenTimestamps worker response");
    }
    return result;
  } finally {
    activeWorkers--;
  }
}
