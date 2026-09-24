import express, { type Express, type Request } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { registerStratigraphyRoutes } from "./routes/stratigraphy";
import { registerOpenApiRoute } from "./routes/openapi";
import { registerMcpRoute } from "./routes/mcp";
import { registerMcpServerCardRoute } from "./routes/mcp-server-card";
import { logger } from "./lib/logger";
import { createPostgresPaymentChallengeStore } from "./lib/postgres-payment-challenge-store";
import { registerNostrStatusRoute } from "./routes/nostr-status";
import { createPostgresMacaroonUsageStore } from "./lib/postgres-macaroon-usage-store";
import { createPostgresMacaroonRevocationStore } from "./lib/postgres-macaroon-revocation-store";
import { createPostgresRevenueLedger } from "./services/postgres-ledger";
import { registerRevenueAnalyticsRoutes } from "./routes/analytics";
import { createPricingEngine } from "./services/pricing";
import { runtimePricingLoad } from "./services/orchestrator";
import {
  createSlidingWindowRateLimiter,
} from "./middleware/rateLimiter";
import { registerSystemHealthRoute } from "./routes/system-health";

const app: Express = express();
const revenueLedger = createPostgresRevenueLedger();
const pricingEngine = createPricingEngine({
  loadProvider: runtimePricingLoad,
  maxLoadMultiplier: Number(process.env.DYNAMIC_FEE_MAX_MULTIPLIER) || 3,
});
const l402RateLimiter = createSlidingWindowRateLimiter({
  limit: Number(process.env.L402_RATE_LIMIT_PER_MINUTE) || 60,
  windowMs: 60_000,
});

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const globalCors = cors({
  exposedHeaders: [
    "WWW-Authenticate",
    "X-L402-Receipt",
    "X-Stratigraphy-Records",
    "X-Stratigraphy-First-Day",
    "X-Stratigraphy-Last-Day",
    "X-L402-Cost-Sats",
    "X-L402-Minimum-Cost-Sats",
    "X-L402-Subscription-Tiers",
  ],
});
app.use((req, res, next) => {
  // Let /mcp answer its own preflight with its explicit method/header policy.
  if (req.path === "/mcp" && req.method === "OPTIONS") return next();
  globalCors(req, res, next);
});
app.use(
  express.json({
    limit: "1mb",
    verify(req, _res, buffer) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

const macaroonUsageStore = createPostgresMacaroonUsageStore();

registerOpenApiRoute(app);
registerMcpServerCardRoute(app);
registerMcpRoute(app, { usageStore: macaroonUsageStore, ledger: revenueLedger });
registerNostrStatusRoute(app);
registerRevenueAnalyticsRoutes(app, revenueLedger);
registerSystemHealthRoute(app, pricingEngine);
app.use("/api", router);
registerStratigraphyRoutes(
  app,
  undefined,
  undefined,
  createPostgresPaymentChallengeStore(),
  macaroonUsageStore,
  createPostgresMacaroonRevocationStore(),
  pricingEngine,
  undefined,
  { revenueLedger, l402RateLimiter },
);

export default app;
