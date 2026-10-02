import express, { type Express, type Request } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { registerStratigraphyRoutes } from "./routes/stratigraphy";
import { registerOpenApiRoute } from "./routes/openapi";
import { registerDocsRoutes } from "./routes/docs";
import { registerMcpRequestGuard, registerMcpRoute } from "./routes/mcp";
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
import { registerLlmExportRoutes } from "./routes/llm-export";
import { registerProvenanceRoutes } from "./routes/provenance";
import { createMeshGossipService } from "./services/meshGossipService";
import { registerZkDriftRoute } from "./routes/zk-drift";

const app: Express = express();
const meshService = createMeshGossipService();
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
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["*"],
    preflightContinue: true,
    exposedHeaders: [
      "*",
      "WWW-Authenticate",
      "X-L402-Receipt",
      "X-Stratigraphy-Records",
      "X-Stratigraphy-First-Day",
      "X-Stratigraphy-Last-Day",
      "X-L402-Cost-Sats",
      "X-L402-Minimum-Cost-Sats",
      "X-L402-Subscription-Tiers",
    ],
  }),
);
// Express 5 requires a regex for a catch-all route rather than the string "*".
// Reflect requested headers: a literal "*" does not authorize credentialed
// browser requests carrying Authorization.
app.use("/api/v1/cost", (_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.removeHeader("Access-Control-Allow-Credentials");
  next();
});
app.options(/.*/, (req, res) => {
  const publicCostRoute = /^\/api\/v1\/cost\/?$/.test(req.path);
  res.vary("Access-Control-Request-Headers");
  res.header("Access-Control-Allow-Origin", publicCostRoute ? "*" : req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] || "*",
  );
  if (publicCostRoute) res.removeHeader("Access-Control-Allow-Credentials");
  else res.header("Access-Control-Allow-Credentials", "true");
  return res.sendStatus(200);
});
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
registerMcpRequestGuard(app);
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
registerDocsRoutes(app);
registerMcpServerCardRoute(app);
registerMcpRoute(app, { usageStore: macaroonUsageStore, ledger: revenueLedger, meshService });
registerNostrStatusRoute(app);
registerRevenueAnalyticsRoutes(app, revenueLedger);
registerSystemHealthRoute(app, pricingEngine);
registerLlmExportRoutes(app);
registerProvenanceRoutes(app, { schedule: true });
registerZkDriftRoute(app);
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
  { revenueLedger, l402RateLimiter, meshService },
);

export default app;
