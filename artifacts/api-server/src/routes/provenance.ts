// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { clientKey } from "../lib/client-address";
import { logger } from "../lib/logger";
import {
  anchorProvenance,
  getProvenanceAnchor,
  OtsCalendarsUnavailableError,
  OtsCliTimeoutError,
  prewarmOtsCli,
  type ProvenanceAnchor,
} from "../services/otsProvenance";
import { buildProvenanceChain } from "../services/provenanceChain";
import { readDataset } from "./stratigraphy";

type RouteOptions = {
  readRecords?: typeof readDataset;
  getAnchor?: typeof getProvenanceAnchor;
  anchor?: typeof anchorProvenance;
  prewarmCli?: () => Promise<void>;
  operatorSecret?: string;
  /** Delay before a failed scheduled stamp is retried, once. */
  retryDelayMs?: number;
  /** Delay after start() before the CLI warm-up runs. */
  warmupDelayMs?: number;
};

export type ProvenanceAnchoringSchedule = {
  /**
   * Starts the background OpenTimestamps timers: one quiet CLI warm-up, the
   * first stamp after delayMs, then a stamp every six hours. Calendar calls
   * never block HTTP startup; each calendar attempt has its own timeout, and
   * a scheduled stamp that fails is retried once, later. Returns a stop
   * function.
   */
  start(delayMs?: number): () => void;
};

type ChainState = ReturnType<typeof buildProvenanceChain>;

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
// The first stamp waits until a freshly booted server has settled: during a
// cold boot the CLI's own start-up competes with both APIs starting.
const STARTUP_STAMP_DELAY_MS = 5 * 60 * 1_000;
// Well before the first stamp, and apart from the zk verifier warm-up at
// 2.5 minutes, one CLI run loads the OpenTimestamps client and primes the
// receipt check that public anchor reads use.
const CLI_WARMUP_DELAY_MS = 90 * 1_000;
// A scheduled stamp that fails for any reason is retried once, after this,
// instead of waiting for the next six-hourly stamp.
const RETRY_DELAY_MS = 10 * 60 * 1_000;
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
  const prewarmCli = options.prewarmCli ?? prewarmOtsCli;
  const operatorSecret =
    options.operatorSecret ?? process.env.MACAROON_OPERATOR_SECRET;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const warmupDelayMs = options.warmupDelayMs ?? CLI_WARMUP_DELAY_MS;
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

    const address = clientKey(req);
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
      const log = req.log ?? logger;
      if (error instanceof OtsCalendarsUnavailableError) {
        log.warn(
          { calendars: error.failures },
          "Provenance anchor operation deferred: OpenTimestamps calendars unavailable",
        );
      } else {
        log.error({ err: error }, "Provenance anchor operation failed");
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
      let stopped = false;
      let retryTimer: NodeJS.Timeout | undefined;
      const warmUp = async () => {
        const startedAt = performance.now();
        try {
          await prewarmCli();
          // Leaves the stored receipt's inspection cached for public reads.
          await getAnchor((await readCurrentState()).headHash);
          logger.info(
            {
              durationMs: Number((performance.now() - startedAt).toFixed(3)),
            },
            "OpenTimestamps CLI pre-warmed",
          );
        } catch (error) {
          logger.warn(
            { err: error },
            "OpenTimestamps CLI warm-up failed; CLI calls still run on demand",
          );
        }
      };
      const runScheduledStamp = (isRetry = false) => {
        void stampCurrentState().catch((error: unknown) => {
          // Retry once, then wait for the next scheduled stamp rather than
          // retrying indefinitely.
          const retry = !isRetry && !stopped && !retryTimer;
          const retryInMs = retry ? retryDelayMs : undefined;
          if (error instanceof OtsCalendarsUnavailableError) {
            logger.warn(
              { calendars: error.failures, retryInMs },
              "Scheduled provenance anchor deferred: OpenTimestamps calendars unavailable",
            );
          } else if (error instanceof OtsCliTimeoutError) {
            logger.warn(
              { retryInMs },
              "Scheduled provenance anchor deferred: OpenTimestamps CLI timed out",
            );
          } else {
            logger.error(
              { err: error, retryInMs },
              "Scheduled provenance anchor operation failed",
            );
          }
          if (retry) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              runScheduledStamp(true);
            }, retryDelayMs);
            retryTimer.unref();
          }
        });
      };
      const warmupTimer = setTimeout(() => void warmUp(), warmupDelayMs);
      const startupTimer = setTimeout(() => runScheduledStamp(), delayMs);
      const intervalTimer = setInterval(
        () => runScheduledStamp(),
        SIX_HOURS_MS,
      );
      warmupTimer.unref();
      startupTimer.unref();
      intervalTimer.unref();
      return () => {
        stopped = true;
        clearTimeout(warmupTimer);
        clearTimeout(startupTimer);
        clearInterval(intervalTimer);
        clearTimeout(retryTimer);
        backgroundTimersScheduled = false;
      };
    },
  };
}
