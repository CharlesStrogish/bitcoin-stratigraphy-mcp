// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { readEscrowBitcoinPrice } from "./escrowPricing";
import { withEscrowLedger, ESCROW_GENESIS, type EscrowState } from "./escrowLedger";

export type EscrowOperation = "create" | "settle" | "lookup" | "receipt" | "stats";
const workerResult = z.object({
  status: z.union([z.literal(200), z.literal(201), z.literal(400),
    z.literal(404), z.literal(422), z.literal(503)]),
  body: z.record(z.unknown()),
});
export type EscrowWorkerResult = z.infer<typeof workerResult>;
export type EscrowLightningSettlement = {
  payment_hash: string;
  amount_sats: number;
  provider: string;
  confirmed_at: string;
};
export type EscrowExecutor = (
  operation: EscrowOperation,
  body: Record<string, unknown>,
  height?: number,
  signal?: AbortSignal,
  lightningSettlement?: EscrowLightningSettlement,
) => Promise<EscrowWorkerResult>;

/** Only staged source code is bundled. The custody DB never enters dist/. */
export const executeEscrow: EscrowExecutor = async (operation, body, height, signal, lightningSettlement) => {
  if (signal?.aborted) throw new Error("Escrow request cancelled");
  const price = operation === "create" ? await readEscrowBitcoinPrice() : undefined;
  return withEscrowLedger(async (state) => {
    const output = await runEscrowWorker(operation, body, state, height, signal, lightningSettlement, price);
    return { state: output.state, result: output.result };
  });
};

export function runEscrowWorker(
  operation: EscrowOperation, body: Record<string, unknown>, state: EscrowState | null,
  height?: number, signal?: AbortSignal, lightningSettlement?: EscrowLightningSettlement,
  price?: number | null, legacyPath = path.resolve(process.cwd(), ".data/escrow/escrow.sqlite3"),
): Promise<{ state: EscrowState; result: EscrowWorkerResult }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Escrow request cancelled"));
    const managedPython = fileURLToPath(
      new URL("../../../.pythonlibs/bin/python3", import.meta.url),
    );
    const allowed = new Set([
      "PATH", "HOME", "LANG", "LC_ALL", "SSL_CERT_FILE", "PYTHONHOME",
      "PYTHONUSERBASE", "REPLIT_PYTHONPATH", "PYTHON_LD_LIBRARY_PATH", "NIX_PROFILES",
    ]);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => allowed.has(key)),
    );
    const child = spawn(existsSync(managedPython) ? managedPython : "python3", [
      fileURLToPath(new URL("./escrow-worker/routers/escrow_worker.py", import.meta.url)),
    ], {
      env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let complete = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: { state: EscrowState; result: EscrowWorkerResult }) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new Error("Escrow request cancelled"));
    const timer = setTimeout(() => finish(new Error("Escrow worker timed out")), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new Error("Escrow worker unavailable")));
    child.stdin.on("error", () => finish(new Error("Escrow worker input failed")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) return finish(new Error("Escrow response exceeds limit"));
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error("Escrow worker failed"));
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = workerResult.parse(output);
        if (!output.state || output.state.version !== 1
            || !Array.isArray(output.state.contracts) || !Array.isArray(output.state.leaves)) {
          throw new Error("Missing durable escrow state");
        }
        finish(undefined, { result, state: output.state });
      } catch {
        finish(new Error("Invalid escrow worker response"));
      }
    });
    child.stdin.end(JSON.stringify({
      operation, body, strata_height: height, btc_usd_price: price,
      lightning_settlement: lightningSettlement,
      state, genesis_id: ESCROW_GENESIS.create_response.escrow_id,
      database_path: legacyPath,
    }));
  });
}
