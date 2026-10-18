// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { readEscrowBitcoinPrice } from "./escrowPricing";
import {
  withEscrowLedger, ESCROW_GENESIS, type EscrowSettlementRecord, type EscrowState,
} from "./escrowLedger";
import { AGENT_ID_PATTERN } from "../lib/agent-id-caveat";

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
  /** Verified agent_id caveat of the paid settlement credential. */
  agentId?: string,
) => Promise<EscrowWorkerResult>;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
// The committed receipt is the only source for the PostgreSQL settlement row.
const settledReceipt = z.object({
  escrow_id: z.string().uuid(),
  leaf_index: z.number().int().nonnegative(),
  merkle_root: hex64,
  execution_leaf_hash: hex64,
  settled_at_strata_block: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
  agent_id: z.string().regex(AGENT_ID_PATTERN).optional(),
  lightning_settlement: z.object({
    payment_hash: hex64,
    amount_sats: z.number().int().positive(),
    provider: z.string().min(1),
  }).passthrough().optional(),
}).passthrough();

/** Derives the attribution row and fails unless the receipt names exactly the requested agent. */
function settlementRecord(body: Record<string, unknown>, agentId?: string): EscrowSettlementRecord {
  const receipt = settledReceipt.parse(body.article_12_receipt);
  if (receipt.agent_id !== agentId) throw new Error("Escrow receipt agent attribution mismatch");
  return {
    escrowId: receipt.escrow_id,
    agentId: receipt.agent_id ?? null,
    leafIndex: receipt.leaf_index,
    executionLeafHash: receipt.execution_leaf_hash,
    merkleRoot: receipt.merkle_root,
    settledAtStrataBlock: receipt.settled_at_strata_block,
    settledAt: receipt.timestamp,
    paymentHash: receipt.lightning_settlement?.payment_hash ?? null,
    tollSats: receipt.lightning_settlement?.amount_sats ?? null,
    settlementProvider: receipt.lightning_settlement?.provider ?? null,
  };
}

/** Only staged source code is bundled. The custody DB never enters dist/. */
export const executeEscrow: EscrowExecutor = async (
  operation, body, height, signal, lightningSettlement, agentId,
) => {
  if (signal?.aborted) throw new Error("Escrow request cancelled");
  const price = operation === "create" ? await readEscrowBitcoinPrice() : undefined;
  return withEscrowLedger((state) => runEscrowWorker(
    operation, body, state, height, signal, lightningSettlement, price, undefined, agentId,
  ));
};

export function runEscrowWorker(
  operation: EscrowOperation, body: Record<string, unknown>, state: EscrowState | null,
  height?: number, signal?: AbortSignal, lightningSettlement?: EscrowLightningSettlement,
  price?: number | null, legacyPath = path.resolve(process.cwd(), ".data/escrow/escrow.sqlite3"),
  agentId?: string,
): Promise<{ state: EscrowState; result: EscrowWorkerResult; settlement?: EscrowSettlementRecord }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Escrow request cancelled"));
    if (agentId !== undefined && (operation !== "settle" || !AGENT_ID_PATTERN.test(agentId))) {
      return reject(new Error("Invalid escrow agent attribution"));
    }
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
    const finish = (error?: Error, value?: {
      state: EscrowState; result: EscrowWorkerResult; settlement?: EscrowSettlementRecord;
    }) => {
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
        const settlement = operation === "settle" && result.status === 200
          ? settlementRecord(result.body, agentId) : undefined;
        finish(undefined, { result, state: output.state, ...(settlement ? { settlement } : {}) });
      } catch {
        finish(new Error("Invalid escrow worker response"));
      }
    });
    child.stdin.end(JSON.stringify({
      operation, body, strata_height: height, btc_usd_price: price,
      lightning_settlement: lightningSettlement,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      state, genesis_id: ESCROW_GENESIS.create_response.escrow_id,
      database_path: legacyPath,
    }));
  });
}
