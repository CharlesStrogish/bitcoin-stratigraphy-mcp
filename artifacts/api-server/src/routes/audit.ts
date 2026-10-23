// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import express, { type Express, type ErrorRequestHandler, type RequestHandler } from "express";
import { clientKey } from "../lib/client-address";
import { createSlidingWindowRateLimiter } from "../middleware/rateLimiter";
import {
  AuditWorkerError,
  verifyAuditEvidence,
} from "../services/auditVerification";

export function registerAuditRoutes(
  app: Express,
  verify = verifyAuditEvidence,
  identityGuard: RequestHandler = (_req, _res, next) => next(),
) {
  const router = express.Router();
  const limiter = createSlidingWindowRateLimiter({
    limit: 10,
    windowMs: 60_000,
  });
  let active = 0;
  let receiving = 0;
  router.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  router.post(
    "/verify",
    (req, res, next) => {
      const budget = limiter.check(clientKey(req));
      if (!budget.allowed) {
        res.setHeader("Retry-After", budget.retryAfterSeconds);
        res
          .status(429)
          .json({ error: "Free verifier rate limit reached; retry later" });
        return;
      }
      if (
        !req.is([
          "application/json",
          "application/x-ndjson",
          "text/plain",
          "application/octet-stream",
        ])
      ) {
        res.status(415).json({
          error: "Use application/json, application/x-ndjson, or text/plain",
        });
        return;
      }
      if (receiving >= 8) {
        res.setHeader("Retry-After", "5");
        res.status(503).json({ error: "Free verifier is busy; retry shortly" });
        return;
      }
      receiving++;
      res.once("close", () => {
        receiving--;
      });
      req.setTimeout(15_000, () => req.destroy());
      next();
    },
    express.raw({ type: () => true, limit: "1mb", inflate: false }),
    identityGuard,
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res
          .status(400)
          .json({ error: "Provide a nonempty audit journal or JSON trace" });
        return;
      }
      if (active >= 2) {
        res.setHeader("Retry-After", "5");
        res.status(503).json({ error: "Free verifier is busy; retry shortly" });
        return;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(req.body);
      } catch {
        res.status(400).json({ error: "Submission must be valid UTF-8" });
        return;
      }
      const aborter = new AbortController();
      req.setTimeout(35_000, () => req.destroy());
      const abort = () => aborter.abort();
      res.once("close", abort);
      active++;
      try {
        const result = await verify(
          { mode: req.is("application/json") ? "trace" : "journal", content },
          aborter.signal,
        );
        if (!res.destroyed) res.json(result);
      } catch (error) {
        if (!res.destroyed)
          res
            .status(error instanceof AuditWorkerError ? error.status : 503)
            .json({
              error:
                error instanceof AuditWorkerError
                  ? error.message
                  : "Verification unavailable",
            });
      } finally {
        active--;
        res.removeListener("close", abort);
      }
    },
  );
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.status === 415
          ? 415
          : 400;
    res.status(status).json({
      error:
        status === 413
          ? "Maximum upload size is 1 MiB"
          : "Unsupported or malformed submission",
    });
  };
  router.use(errors);
  // Intentionally mounted independently of MCP and all paid route middleware.
  app.use("/api/audit", router);
}
