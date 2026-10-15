// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { logger } from "../lib/logger";
import {
  anchorProvenance,
  getProvenanceAnchor,
  type ProvenanceAnchor,
} from "../services/otsProvenance";
import { buildProvenanceChain } from "../services/provenanceChain";
import { readDataset } from "./stratigraphy";

type RouteOptions = {
  readRecords?: typeof readDataset;
  getAnchor?: typeof getProvenanceAnchor;
  anchor?: typeof anchorProvenance;
  operatorSecret?: string;
};

export type ProvenanceAnchoringSchedule = {
  /**
   * Starts the background OpenTimestamps stamping timers (first stamp after
   * delayMs, then every six hours). Calendar calls never block HTTP startup;
   * each CLI operation has its own timeout. Returns a stop function.
   */
  start(delayMs?: number): () => void;
};

type ChainState = ReturnType<typeof buildProvenanceChain>;

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const STARTUP_STAMP_DELAY_MS = 5_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

let activeAnchorOperation: Promise<ProvenanceAnchor> | undefined;
let backgroundTimersScheduled = false;

function matchesSecret(candidate: string, secret: string): boolean {
  const expected = Buffer.from(secret, "utf8");
  const supplied = Buffer.from(candidate, "utf8");
  const comparable = Buffer.alloc(expected.length);
  supplied.copy(comparable, 0, 0, expected.length);
  const equal = timingSafeEqual(expected, comparable);
  return equal && supplied.length === expected.length;
}

function isMatchingAnchor(
  anchor: ProvenanceAnchor | undefined,
  state: ChainState,
): anchor is ProvenanceAnchor {
  return Boolean(
    anchor &&
    anchor.headHash === state.headHash &&
    anchor.merkleRoot === state.merkleRoot &&
    anchor.totalDepth === state.totalDepth,
  );
}

export function registerProvenanceRoutes(
  app: Express,
  options: RouteOptions = {},
): ProvenanceAnchoringSchedule {
  const readRecords = options.readRecords ?? readDataset;
  const getAnchor = options.getAnchor ?? getProvenanceAnchor;
  const anchor = options.anchor ?? anchorProvenance;
  const operatorSecret =
    options.operatorSecret ?? process.env.MACAROON_OPERATOR_SECRET;
  const requestsByAddress = new Map<string, number[]>();

  async function readCurrentState(): Promise<ChainState> {
    return buildProvenanceChain(await readRecords());
  }

  async function stampCurrentState(): Promise<ProvenanceAnchor> {
    if (activeAnchorOperation) return activeAnchorOperation;
    const operation = (async () => {
      const state = await readCurrentState();
      const result = await anchor({
        headHash: state.headHash,
        merkleRoot: state.merkleRoot,
        totalDepth: state.totalDepth,
      });
      if (!isMatchingAnchor(result, state)) {
        throw new Error(
          "OpenTimestamps service returned an anchor for stale provenance state",
        );
      }
      return result;
    })();
    activeAnchorOperation = operation;
    try {
      return await operation;
    } finally {
      if (activeAnchorOperation === operation)
        activeAnchorOperation = undefined;
    }
  }

  function isRateLimited(address: string): boolean {
    const now = Date.now();
    const recentRequests = (requestsByAddress.get(address) ?? []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    if (recentRequests.length >= RATE_LIMIT_MAX) {
      requestsByAddress.set(address, recentRequests);
      return true;
    }
    recentRequests.push(now);
    requestsByAddress.set(address, recentRequests);
    return false;
  }

  app.get("/api/provenance/chain", async (_req, res): Promise<void> => {
    try {
      const state = await readCurrentState();
      const storedAnchor = await getAnchor(state.headHash);
      const latestOtsStatus = isMatchingAnchor(storedAnchor, state)
        ? storedAnchor.otsStatus
        : "not_anchored";
      res.json({
        totalDepth: state.totalDepth,
        merkleRoot: state.merkleRoot,
        latestOtsStatus,
        genesisHash: state.genesisHash,
        headHash: state.headHash,
      });
    } catch (error) {
      logger.error({ err: error }, "Provenance chain lookup failed");
      res.status(503).json({ error: "Provenance chain is unavailable" });
    }
  });

  app.get("/api/provenance/anchor", async (_req, res): Promise<void> => {
    try {
      const state = await readCurrentState();
      const storedAnchor = await getAnchor(state.headHash);
      if (storedAnchor && !isMatchingAnchor(storedAnchor, state)) {
        res.status(409).json({
          error: "Stored provenance anchor does not match the current chain",
        });
        return;
      }
      res.json({
        headHash: state.headHash,
        merkleRoot: state.merkleRoot,
        totalDepth: state.totalDepth,
        otsStatus: storedAnchor?.otsStatus ?? "not_anchored",
        ...(storedAnchor
          ? {
              otsProof: storedAnchor.otsProof,
              updatedAt: storedAnchor.updatedAt,
            }
          : {}),
      });
    } catch (error) {
      logger.error({ err: error }, "Provenance anchor lookup failed");
      res.status(503).json({ error: "Provenance anchor is unavailable" });
    }
  });

  app.post("/api/provenance/anchor", async (req, res): Promise<void> => {
    if (!operatorSecret) {
      res
        .status(503)
        .json({ error: "Operator authentication is not configured" });
      return;
    }

    const authorization = req.get("authorization") ?? "";
    const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
    if (!token || !matchesSecret(token, operatorSecret)) {
      res
        .status(401)
        .json({ error: "A valid operator Bearer token is required" });
      return;
    }

    const address = req.ip || req.socket.remoteAddress || "unknown";
    if (isRateLimited(address)) {
      res
        .status(429)
        .json({ error: "Provenance anchoring rate limit exceeded" });
      return;
    }

    try {
      const result = await stampCurrentState();
      res.json(result);
    } catch (error) {
      if (req.log) {
        req.log.error({ err: error }, "Provenance anchor operation failed");
      } else {
        logger.error({ err: error }, "Provenance anchor operation failed");
      }
      res
        .status(503)
        .json({ error: "Unable to anchor current provenance state" });
    }
  });

  return {
    start(delayMs = STARTUP_STAMP_DELAY_MS) {
      if (backgroundTimersScheduled) return () => {};
      backgroundTimersScheduled = true;
      const runScheduledStamp = () => {
        void stampCurrentState().catch((error: unknown) => {
          logger.error(
            { err: error },
            "Scheduled provenance anchor operation failed",
          );
        });
      };
      const startupTimer = setTimeout(runScheduledStamp, delayMs);
      const intervalTimer = setInterval(runScheduledStamp, SIX_HOURS_MS);
      startupTimer.unref();
      intervalTimer.unref();
      return () => {
        clearTimeout(startupTimer);
        clearInterval(intervalTimer);
        backgroundTimersScheduled = false;
      };
    },
  };
}
