import express, { type Express, type Request } from "express";
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
  createPublicRateLimiter,
  createPublicWebRateLimitMiddleware,
} from "./middleware/rateLimiter";
import { registerSystemHealthRoute } from "./routes/system-health";
import { registerLlmExportRoutes } from "./routes/llm-export";
import { registerProvenanceRoutes } from "./routes/provenance";
import { createMeshGossipService } from "./services/meshGossipService";
import { registerZkDriftRoute } from "./routes/zk-drift";
import { registerPublicCors } from "./middleware/publicCors";
import { registerAuditRoutes } from "./routes/audit";
import { registerEscrowRoutes } from "./routes/escrow";
import { registerEnterpriseRoutes } from "./routes/enterprise";

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

const publicRateLimiter = createPublicRateLimiter();
app.disable("x-powered-by");
registerPublicCors(app, createPublicWebRateLimitMiddleware(publicRateLimiter));
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
registerAuditRoutes(app);
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
registerMcpRoute(app, {
  usageStore: macaroonUsageStore,
  ledger: revenueLedger,
  meshService,
  publicRateLimiter,
});
registerNostrStatusRoute(app);
registerRevenueAnalyticsRoutes(app, revenueLedger);
registerSystemHealthRoute(app, pricingEngine);
registerLlmExportRoutes(app);
registerEnterpriseRoutes(app);
registerProvenanceRoutes(app, { schedule: true });
registerZkDriftRoute(app);
registerEscrowRoutes(app, {
  usageStore: macaroonUsageStore,
  revocationStore: createPostgresMacaroonRevocationStore(),
});
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
