// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express, Request } from "express";
import { generateDriftProof } from "../services/zkDriftService";

type DriftProofResult = Awaited<ReturnType<typeof generateDriftProof>>;
type DriftProofGenerator = typeof generateDriftProof;

type RouteOptions = {
  generateDriftProof?: DriftProofGenerator;
};

const MAX_BODY_BYTES = 4 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 10;
const MAX_CONCURRENT_PROOFS = 2;
const DEFAULT_ENTROPY_THRESHOLD = 0.85;
const MAX_BLOCK_HEIGHT = 0xffff_ffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isQueueFullError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /queue|overload/i.test(name) || /queue (?:is )?full|overload/i.test(message);
}

function requestBodyBytes(req: Request): number {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (rawBody) return rawBody.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(req.body ?? null), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function registerZkDriftRoute(
  app: Express,
  options: RouteOptions = {},
): void {
  const generate = options.generateDriftProof ?? generateDriftProof;
  const recentRequests = new Map<string, number[]>();
  let activeProofs = 0;

  function rateLimited(address: string): boolean {
    const now = Date.now();
    const recent = (recentRequests.get(address) ?? []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    if (!recentRequests.has(address) && recentRequests.size >= 1_000) {
      for (const [key, timestamps] of recentRequests) {
        if (timestamps.every((timestamp) => now - timestamp >= RATE_LIMIT_WINDOW_MS)) {
          recentRequests.delete(key);
        }
      }
      if (recentRequests.size >= 1_000) return true;
    }
    if (recent.length >= RATE_LIMIT_REQUESTS) {
      recentRequests.set(address, recent);
      return true;
    }
    recent.push(now);
    recentRequests.set(address, recent);
    return false;
  }

  app.post("/api/zk/drift", async (req, res): Promise<void> => {
    if (requestBodyBytes(req) > MAX_BODY_BYTES) {
      res.status(400).json({ error: "Request body exceeds the 4 KiB limit" });
      return;
    }
    if (!isRecord(req.body)) {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }

    const allowedFields = new Set([
      "sessionContextHash",
      "blockHeight",
      "entropyThreshold",
    ]);
    if (Object.keys(req.body).some((key) => !allowedFields.has(key))) {
      res.status(400).json({ error: "Request contains unknown fields" });
      return;
    }

    const { sessionContextHash, blockHeight, entropyThreshold } = req.body;
    if (
      typeof sessionContextHash !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(sessionContextHash)
    ) {
      res.status(400).json({
        error: "sessionContextHash must be exactly 64 hexadecimal characters",
      });
      return;
    }

    const validHeight = blockHeight === undefined ||
      (typeof blockHeight === "number" &&
        Number.isSafeInteger(blockHeight) &&
        blockHeight >= 0 &&
        blockHeight <= MAX_BLOCK_HEIGHT) ||
      (typeof blockHeight === "string" &&
        /^(0|[1-9][0-9]*)$/.test(blockHeight) &&
        (blockHeight.length < 10 ||
          (blockHeight.length === 10 && blockHeight <= String(MAX_BLOCK_HEIGHT))));
    if (!validHeight) {
      res.status(400).json({
        error: "blockHeight must be a nonnegative integer or canonical decimal string",
      });
      return;
    }

    const threshold = entropyThreshold === undefined
      ? DEFAULT_ENTROPY_THRESHOLD
      : entropyThreshold;
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    ) {
      res.status(400).json({ error: "entropyThreshold must be a number from 0 to 1" });
      return;
    }

    const address = req.ip || req.socket.remoteAddress || "unknown";
    if (rateLimited(address)) {
      res.status(429).json({ error: "Drift proof request rate limit exceeded" });
      return;
    }
    if (activeProofs >= MAX_CONCURRENT_PROOFS) {
      res.status(429).json({ error: "Drift proof generation queue is full" });
      return;
    }

    activeProofs += 1;
    try {
      const result: DriftProofResult = await generate(
        {
          sessionContextHash,
          ...(blockHeight === undefined ? {} : { blockHeight }),
          entropyThreshold: threshold,
        },
        {},
      );
      res.status(200).json({
        ...result,
        entropyInterpretation:
          "thermodynamicEntropyBits is a hash bit-balance proxy, not a physical entropy measurement.",
        proofInterpretation:
          "This proof attests the drift circuit relation against public-provider block data, not Bitcoin consensus or in-circuit proof-of-work. The Groth16 parameters come from a local single-party setup, not an independently verified ceremony.",
      });
    } catch (error) {
      if (isQueueFullError(error)) {
        res.status(429).json({ error: "Drift proof generation queue is full" });
        return;
      }
      res.status(503).json({ error: "Drift proof provider is unavailable" });
    } finally {
      activeProofs -= 1;
    }
  });
}