// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, SimplePool, type Event } from "nostr-tools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "@workspace/db";
import { canonical, loadArticle12IssuerKey, signIssuerPayload } from "../lib/article12-signature";
import { canonicalResultContent } from "../lib/mcp-response-signature";
import type { PipelineReceiptStore } from "../lib/mcp-pipeline";
import type { EscrowSettlementRecord } from "./escrowLedger";
import { parsePrivateKey } from "./nostrAttestation";
import { logger } from "../lib/logger";

export const RECEIPT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
] as const;

type Proof = {
  schema: "bitcoin-stratigraphy/receipt-proof/v1";
  receipt_type: "mcp-single" | "mcp-pipeline" | "rfc6962-escrow";
  task_sha256: string;
  evidence_sha256: string;
  settlement_amount_sats: number;
  timestamp: string;
  execution_status: "completed" | "failed" | "interrupted";
  merkle_root?: string;
  steps_sha256?: string;
};
type Log = Pick<typeof logger, "warn" | "info">;
type Database = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
type RelayPool = {
  publish(relays: string[], event: Event, options: { maxWait: number }): Promise<string>[];
  destroy(): void;
};
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Reconstruct an allowlist; never serialize or spread an internal receipt into a public event. */
export function receiptProof(type: Proof["receipt_type"], receipt: Record<string, unknown>): Proof {
  const task = type === "mcp-pipeline" ? receipt.request_sha256
    : type === "mcp-single" ? receipt.task_sha256 : receipt.executionLeafHash;
  const amount = type === "rfc6962-escrow" ? receipt.tollSats : receipt.amount_sats;
  const timestamp = type === "mcp-pipeline" ? receipt.finished_at
    : type === "mcp-single" ? receipt.completed_at : receipt.settledAt;
  if (!hex(task) || !positive(amount) || typeof timestamp !== "string" ||
      !Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid public receipt proof");
  const root = type === "rfc6962-escrow" ? receipt.merkleRoot : undefined;
  const status = type === "mcp-pipeline" ? receipt.status : "completed";
  if (status !== "completed" && status !== "failed" && status !== "interrupted")
    throw new Error("Invalid receipt execution status");
  if (root !== undefined && !hex(root)) throw new Error("Invalid receipt Merkle root");
  if (receipt.steps_sha256 !== undefined && !hex(receipt.steps_sha256))
    throw new Error("Invalid receipt steps commitment");
  return {
    schema: "bitcoin-stratigraphy/receipt-proof/v1", receipt_type: type,
    task_sha256: task, evidence_sha256: hash(receipt),
    settlement_amount_sats: amount, timestamp, execution_status: status,
    ...(root === undefined ? {} : { merkle_root: root }),
    ...(type === "mcp-pipeline" && hex(receipt.steps_sha256)
      ? { steps_sha256: receipt.steps_sha256 } : {}),
  };
}

export function createReceiptMesh(options: {
  enabled?: boolean;
  database?: Database;
  log?: Log;
  privateKey?: () => string | undefined;
  poolFactory?: () => RelayPool;
  signingKey?: typeof loadArticle12IssuerKey;
  timeoutMs?: number;
  maxPending?: number;
  concurrency?: number;
} = {}) {
  const log = options.log ?? logger;
  const database = options.database ?? pool;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const waiting: (() => Promise<void>)[] = [];
  let pending = 0;
  let active = 0;
  const idle: (() => void)[] = [];
  // Logging must not become a second failure channel (including custom test loggers).
  const warn = (message: string, relay?: string) => {
    try { log.warn(relay ? { relay } : {}, message); } catch { /* best effort */ }
  };
  const pump = () => {
    while (waiting.length && active < (options.concurrency ?? 4)) {
      const work = waiting.shift()!;
      active++;
      void Promise.resolve().then(work).catch(() => warn("Receipt mesh background job failed"))
        .finally(() => {
          active--;
          pending--;
          pump();
          if (pending === 0) idle.splice(0).forEach(resolve => resolve());
        });
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    if (options.enabled === false) return;
    if (pending >= (options.maxPending ?? 256)) {
      warn("Receipt mesh queue full; broadcast skipped");
      return;
    }
    pending++;
    waiting.push(work);
    // No signing, hashing, database or relay work runs in the request's call stack.
    setImmediate(pump);
  };
  const broadcast = async (proof: Proof) => {
    const secret = (options.privateKey ?? (() => process.env.NOSTR_PRIVATE_KEY))();
    if (!secret) { warn("Receipt mesh signing key unavailable; broadcast skipped"); return; }
    const event = finalizeEvent({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["d", `receipt-proof:${proof.evidence_sha256}`],
        ["t", "bitcoin-stratigraphy"], ["t", "receipt-proof"],
        ["x", proof.evidence_sha256],
      ],
      content: JSON.stringify(proof),
    }, parsePrivateKey(secret));
    const relays = (options.poolFactory ?? (() => new SimplePool()))();
    try {
      await Promise.all(RECEIPT_RELAYS.map(async relay => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          // One relay's synchronous throw, reject or never-settling ACK cannot
          // prevent attempts to the others. Observe late rejections via race.
          await Promise.race([
            Promise.resolve().then(() => relays.publish([relay], event, { maxWait: timeoutMs })[0]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("relay timeout"));
              }, timeoutMs);
              timer.unref();
            }),
          ]);
        } catch (error) {
          const timeout = timedOut || error instanceof Error && /timeout|timed out/i.test(error.message);
          warn(timeout ? "Receipt mesh relay timed out" : "Receipt mesh relay rejected", relay);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }));
    } finally {
      try { relays.destroy(); } catch { warn("Receipt mesh relay cleanup failed"); }
    }
  };
  return {
    /** Called only after the underlying pipeline store successfully saves its final receipt. */
    pipeline(receipt: Record<string, unknown>) {
      if (["completed", "failed", "interrupted"].includes(String(receipt.status)) && positive(receipt.amount_sats))
        enqueue(async () => broadcast(receiptProof("mcp-pipeline", receipt)));
    },
    /** Called after the RFC 6962 state and append-only settlement have COMMITted. */
    escrow(receipt: EscrowSettlementRecord) {
      if (positive(receipt.tollSats) && hex(receipt.paymentHash))
        enqueue(async () => broadcast(receiptProof("rfc6962-escrow", { ...receipt })));
    },
    /** Single tools have signed results but no common persisted completion receipt.
     * Journal a commitment off the response path, then and only then publish it. */
    single(tool: string, result: CallToolResult, paymentHash: string) {
      if (result.isError || !hex(paymentHash)) return;
      const completedAt = new Date().toISOString();
      enqueue(async () => {
        const invoice = await database.query(
          "SELECT sats_received FROM revenue_ledger WHERE payment_hash=$1 AND channel='L402'",
          [paymentHash],
        );
        const amount = Number(invoice.rows[0]?.sats_received);
        if (!positive(amount)) { warn("Receipt mesh invoice evidence unavailable; broadcast skipped"); return; }
        const outputHash = createHash("sha256").update(canonicalResultContent(result)).digest("hex");
        const receiptId = randomUUID();
        const receipt = signIssuerPayload({
          version: "mcp-single-receipt-v1", receipt_id: receiptId,
          tool, task_sha256: hash({ tool, output_sha256: outputHash, receipt_id: receiptId }),
          output_sha256: outputHash, amount_sats: amount, completed_at: completedAt,
          amount_scope: "settled_invoice_total_not_per_pass_redemption",
        }, (options.signingKey ?? loadArticle12IssuerKey)(),
        "mcp-single-ed25519-v1", "bitcoin-stratigraphy/mcp-single/v1\n");
        await database.query(
          "INSERT INTO enterprise_affiliate_security (record_key,payload) VALUES ($1,$2::jsonb)",
          [`mcp-single:${receiptId}`, JSON.stringify(receipt)],
        );
        await broadcast(receiptProof("mcp-single", receipt));
      });
    },
    /** Test/shutdown helper only; request handlers must never await relay drainage. */
    drain(): Promise<void> {
      return pending === 0 ? Promise.resolve() : new Promise(resolve => idle.push(resolve));
    },
  };
}

export type ReceiptMesh = ReturnType<typeof createReceiptMesh>;
// Unit suites must never leak fixtures onto public relays. Inject an enabled mock
// mesh to exercise production behavior without network access.
export const receiptMesh = createReceiptMesh({ enabled: process.env.NODE_ENV !== "test" });

export function withPipelineReceiptBroadcast(store: PipelineReceiptStore, mesh: Pick<ReceiptMesh, "pipeline"> = receiptMesh): PipelineReceiptStore {
  return {
    ready: () => store.ready(),
    reserve: (key, value) => store.reserve(key, value),
    async save(key, value) {
      await store.save(key, value);
      if (["completed", "failed", "interrupted"].includes(String(value.status)) &&
          value.receipt && typeof value.receipt === "object") {
        try { mesh.pipeline(value.receipt as Record<string, unknown>); }
        catch { /* Broadcast scheduling must never change a persisted settlement. */ }
      }
    },
  };
}
