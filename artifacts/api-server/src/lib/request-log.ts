import type { IncomingMessage, ServerResponse } from "node:http";
import type { RateLimitRefusal } from "../middleware/rateLimiter";

function refusalOf(res: ServerResponse): RateLimitRefusal | undefined {
  return (res as ServerResponse & { locals?: { rateLimit?: RateLimitRefusal } })
    .locals?.rateLimit;
}

/**
 * pino-http hooks. 429 responses log at warn as "request rate limited", with
 * the limiter's refusal details when it recorded them (a per-boot client
 * reference, never a raw address). Every other response keeps pino-http's
 * default level and message.
 */
export const requestLogHooks = {
  customLogLevel: (
    _req: IncomingMessage,
    res: ServerResponse,
    error?: Error,
  ): "warn" | "info" => (!error && res.statusCode === 429 ? "warn" : "info"),
  customSuccessMessage: (req: IncomingMessage, res: ServerResponse): string => {
    if (req.readableAborted || !res.writableEnded) return "request aborted";
    return res.statusCode === 429
      ? "request rate limited"
      : "request completed";
  },
  customSuccessObject: (
    _req: IncomingMessage,
    res: ServerResponse,
    value: Record<string, unknown>,
  ): Record<string, unknown> => {
    const refusal = refusalOf(res);
    return refusal ? { ...value, rateLimit: refusal } : value;
  },
};
