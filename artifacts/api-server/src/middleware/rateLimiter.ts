import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";

export const PUBLIC_RATE_LIMIT = 100;
export const PUBLIC_RATE_WINDOW_MS = 15 * 60_000;

/** Express resolves the trusted proxy chain; never read raw forwarding headers. */
export function rateLimitIpKey(request: Request): string {
  const rawAddress = request.ip || request.socket.remoteAddress || "unknown";
  // URL parsers reject IPv6 scope identifiers even though socket addresses
  // and net.isIP accept them. Interface names must not split a subnet budget.
  const address = rawAddress.includes(":")
    ? rawAddress.split("%")[0]!
    : rawAddress;
  if (isIP(address) !== 6) return address;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const leading = left ? left.split(":") : [];
  const trailing = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? leading
      : [
          ...leading,
          ...Array(8 - leading.length - trailing.length).fill("0"),
          ...trailing,
        ];
  // IPv4-mapped sockets share the IPv4 budget; native IPv6 rotates within /64.
  if (
    groups.slice(0, 5).every((group) => parseInt(group, 16) === 0) &&
    parseInt(groups[5]!, 16) === 0xffff
  ) {
    const high = parseInt(groups[6]!, 16);
    const low = parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
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

export function createHttpRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
  keyForRequest: (request: Request) => string = rateLimitIpKey,
  policy?: { limit: number; windowMs: number },
): RequestHandler {
  return (req, res, next) => {
    const result = limiter.check(keyForRequest(req));
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
  };
}

export function createPublicRateLimiter(): SlidingWindowRateLimiter {
  return createSlidingWindowRateLimiter({
    limit: PUBLIC_RATE_LIMIT,
    windowMs: PUBLIC_RATE_WINDOW_MS,
  });
}

export function createPublicRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter = createPublicRateLimiter(),
): RequestHandler {
  return createHttpRateLimitMiddleware(limiter, rateLimitIpKey, {
    limit: PUBLIC_RATE_LIMIT,
    windowMs: PUBLIC_RATE_WINDOW_MS,
  });
}

/** Apply before body parsing. MCP classification happens after its bounded parser. */
export function createPublicWebRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
): RequestHandler {
  const enforce = createPublicRateLimitMiddleware(limiter);
  const existingPaidRestRoutes = new Set([
    "/api/v1/stratigraphy",
    "/api/v1/stratigraphy/l402",
    "/api/v1/stratigraphy/stream",
    "/api/v1/zk/ground",
    "/api/v1/zk/attest",
  ]);
  return (req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/$/, "") || "/";
    if (path === "/mcp" || existingPaidRestRoutes.has(path)) return next();
    enforce(req, res, next);
  };
}
