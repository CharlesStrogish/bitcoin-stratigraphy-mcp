import type { Request, RequestHandler } from "express";

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
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, number[]>();

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
      let timestamps = windows.get(key);
      if (!timestamps) {
        if (windows.size >= maxKeys) {
          const oldest = windows.keys().next();
          if (!oldest.done) windows.delete(oldest.value);
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
            Math.ceil(
              (timestamps[0]! + options.windowMs - atMs) / 1_000,
            ),
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
      if (key === undefined) windows.clear();
      else windows.delete(key);
    },
  };
}

export function createHttpRateLimitMiddleware(
  limiter: SlidingWindowRateLimiter,
  keyForRequest: (request: Request) => string = (request) =>
    request.ip || request.socket.remoteAddress || "unknown",
): RequestHandler {
  return (req, res, next) => {
    const result = limiter.check(keyForRequest(req));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}