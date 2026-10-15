import { createHmac, randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import {
  addressKey,
  clientKey,
  resolveClientAddress,
  type ClientAddressSource,
} from "../lib/client-address";

export const PUBLIC_RATE_LIMIT = 100;
export const PUBLIC_RATE_WINDOW_MS = 15 * 60_000;

/** Resolved client budget key; see lib/client-address for the proxy chain. */
export function rateLimitIpKey(request: Request): string {
  return clientKey(request);
}

/** Attached to refused responses for the request log; never a raw address. */
export type RateLimitRefusal = {
  limiter: string;
  retryAfterSeconds: number;
  clientRef: string;
  clientSource?: ClientAddressSource;
};

// A per-process key lets operators correlate refusals from one client within
// a boot without logging addresses or hashes that can be reversed offline.
const clientReferenceKey = randomBytes(32);

export function clientReference(key: string): string {
  return createHmac("sha256", clientReferenceKey)
    .update(key)
    .digest("hex")
    .slice(0, 12);
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type SlidingWindowRateLimiter = {
  check(key: string, atMs?: number): RateLimitResult;
  reset(key?: string): void;
};

export function createSlidingWindowRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}): SlidingWindowRateLimiter {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
    throw new RangeError("Rate limit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
    throw new RangeError("Rate-limit window must be a positive integer");
  }
  if (
    options.maxKeys !== undefined &&
    (!Number.isSafeInteger(options.maxKeys) || options.maxKeys <= 0)
  ) {
    throw new RangeError("Rate-limit key capacity must be a positive integer");
  }
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, number[]>();
  const sweepIntervalMs = Math.min(options.windowMs, 60_000);
  let nextSweepAt = 0;

  const prune = (timestamps: number[], atMs: number) => {
    const cutoff = atMs - options.windowMs;
    let expired = 0;
    while (expired < timestamps.length && timestamps[expired]! <= cutoff) {
      expired += 1;
    }
    if (expired > 0) timestamps.splice(0, expired);
  };

  return {
    check(key, atMs = now()) {
      // Amortize bounded cleanup without allocating timers or evicting active IPs.
      if (atMs >= nextSweepAt) {
        const cutoff = atMs - options.windowMs;
        for (const [storedKey, timestamps] of windows) {
          if (timestamps[timestamps.length - 1]! <= cutoff)
            windows.delete(storedKey);
        }
        nextSweepAt = atMs + sweepIntervalMs;
      }
      let timestamps = windows.get(key);
      if (!timestamps) {
        if (windows.size >= maxKeys) {
          // Fail closed: rotating source addresses must not erase active budgets.
          return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((nextSweepAt - atMs) / 1_000),
            ),
          };
        }
        timestamps = [];
        windows.set(key, timestamps);
      }
      prune(timestamps, atMs);
      if (timestamps.length >= options.limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((timestamps[0]! + options.windowMs - atMs) / 1_000),
          ),
        };
      }
      timestamps.push(atMs);
      return {
        allowed: true,
        remaining: options.limit - timestamps.length,
        retryAfterSeconds: 0,
      };
    },
    reset(key) {
      if (key === undefined) {
        windows.clear();
        nextSweepAt = 0;
      } else windows.delete(key);
    },
  };
}

function applyRateLimit(
  limiter: SlidingWindowRateLimiter,
  key: string,
  res: Response,
  next: () => void,
  label: string,
  policy?: { limit: number; windowMs: number },
  clientSource?: ClientAddressSource,
): void {
  const result = limiter.check(key);
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  res.setHeader("RateLimit-Remaining", String(result.remaining));
  if (policy) {
    res.setHeader(
      "RateLimit-Policy",
      `${policy.limit};w=${policy.windowMs / 1_000}`,
    );
    res.setHeader("RateLimit-Limit", String(policy.limit));
  }
  if (!result.allowed) {
    res.locals.rateLimit = {
      limiter: label,
      retryAfterSeconds: result.retryAfterSeconds,
      clientRef: clientReference(key),
      ...(clientSource ? { clientSource } : {}),
    } satisfies RateLimitRefusal;
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.setHeader("Cache-Control", "no-store");
    res.status(429).json({
      error: "Too many requests",
      code: "rate_limit_exceeded",
      retry_after: result.retryAfterSeconds,
    });
    return;
  }
  next();
}

export function createHttpRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
  keyForRequest: (request: Request) => string = rateLimitIpKey,
  policy?: { limit: number; windowMs: number },
  label = "http",
): RequestHandler {
  return (req, res, next) => {
    applyRateLimit(limiter, keyForRequest(req), res, next, label, policy);
  };
}

export function createPublicRateLimiter(): SlidingWindowRateLimiter {
  return createSlidingWindowRateLimiter({
    limit: PUBLIC_RATE_LIMIT,
    windowMs: PUBLIC_RATE_WINDOW_MS,
  });
}

export type PublicRateLimitOptions = {
  /**
   * Skip loopback GET/HEAD/OPTIONS requests that carry no X-Forwarded-For.
   * In a published deployment those are Replit's own health and discovery
   * probes: every external request arrives through the router, which always
   * appends X-Forwarded-For. Defaults to published deployments only.
   */
  exemptPlatformProbes?: boolean;
};

const probeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function createPublicRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter = createPublicRateLimiter(),
  options: PublicRateLimitOptions = {},
): RequestHandler {
  const exemptPlatformProbes =
    options.exemptPlatformProbes ?? process.env.REPLIT_DEPLOYMENT === "1";
  const policy = { limit: PUBLIC_RATE_LIMIT, windowMs: PUBLIC_RATE_WINDOW_MS };
  return (req, res, next) => {
    const client = resolveClientAddress(req);
    if (
      exemptPlatformProbes &&
      client.source === "loopback" &&
      probeMethods.has(req.method)
    ) {
      next();
      return;
    }
    applyRateLimit(
      limiter,
      addressKey(client.address),
      res,
      next,
      "public",
      policy,
      client.source,
    );
  };
}

/**
 * Routes whose payment gate is the request control. Unauthenticated calls get
 * a 402 challenge capped per client by the L402 challenge limiter, and paid
 * retries carrying Authorization: L402 must never spend the free budget.
 */
const existingPaidRestRoutes = new Set([
  "/api/v1/stratigraphy",
  "/api/v1/stratigraphy/l402",
  "/api/v1/stratigraphy/stream",
  "/api/v1/zk/ground",
  "/api/v1/zk/attest",
]);

function isPaidEscrowRoute(method: string, path: string): boolean {
  if (method === "POST") {
    return path === "/api/v1/escrow/create" || path === "/api/v1/escrow/settle";
  }
  return (
    (method === "GET" || method === "HEAD") &&
    /^\/api\/v1\/escrow\/receipt\/[^/]+$/.test(path)
  );
}

/** Apply before body parsing. MCP classification happens after its bounded parser. */
export function createPublicWebRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
  options: PublicRateLimitOptions = {},
): RequestHandler {
  const enforce = createPublicRateLimitMiddleware(limiter, options);
  return (req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/$/, "") || "/";
    if (
      path === "/mcp" ||
      existingPaidRestRoutes.has(path) ||
      isPaidEscrowRoute(req.method, path)
    ) {
      return next();
    }
    enforce(req, res, next);
  };
}
