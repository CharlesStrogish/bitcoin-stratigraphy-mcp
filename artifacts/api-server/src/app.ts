import express, { type Express, type Request } from "express";
import pinoHttp from "pino-http";
import { createClientChainCheck } from "./lib/client-address";
import { requestLogHooks } from "./lib/request-log";
import router from "./routes";
import { registerStratigraphyRoutes } from "./routes/stratigraphy";
import { registerOpenApiRoute } from "./routes/openapi";
import { registerDocsRoutes } from "./routes/docs";
import {
  mcpToolDefinitions,
  registerMcpRequestGuard,
  registerMcpRoute,
} from "./routes/mcp";
import { registerToolIntegrityRoute } from "./routes/tool-integrity";
import { registerMcpServerCardRoute } from "./routes/mcp-server-card";
import { logger } from "./lib/logger";
import { createMcpAsyncTaskRunner } from "./lib/mcp-async-tasks";
import { loadToolIntegrityKey } from "./lib/tool-integrity";
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
import { apiRootAliases } from "./middleware/apiRootAliases";
import { registerPublicCors } from "./middleware/publicCors";
import { registerAuditRoutes } from "./routes/audit";
import { registerEscrowRoutes } from "./routes/escrow";
import { registerEnterpriseRoutes } from "./routes/enterprise";
import { createEscrowRecovery } from "./services/escrowRecovery";
import { createPostgresNip98RevocationStore } from "./lib/nip98-revocation-store";
import { registerComplianceRoutes } from "./routes/compliance";
import { EnterpriseEconomics, configureEnterpriseEconomics } from "./lib/enterprise-economics";
import { createPostgresEnterpriseEconomicsStore } from "./lib/enterprise-economics-store";
import { createEnterpriseEconomicsMiddleware } from "./middleware/enterprise-economics";
import { registerCryptographicAuditRoutes } from "./routes/cryptographic-audit";
import { registerCertifiedOracleRoutes } from "./routes/certified-oracle";
import {
  createNip98RevocationGuard, registerNip98RevocationAdmin,
} from "./middleware/nip98-revocation";

const app: Express = express();
// Started by the server entry once the HTTP port is bound; escrow routes wait on it.
export const escrowRecovery = createEscrowRecovery({ logger });
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
// First: /api/openapi.json, /api/mcp and /api/.well-known/* are served as
// their root routes, through the same middleware.
app.use(apiRootAliases);
// Logged ahead of CORS and the public limiter so refusals reach deployment logs.
app.use(
  pinoHttp({
    logger,
    ...requestLogHooks,
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
app.use(
  createClientChainCheck((summary) => {
    const message = "client address chain check";
    if (summary.layout === "unexpected") {
      logger.warn({ clientAddressChain: summary }, message);
    } else logger.info({ clientAddressChain: summary }, message);
  }),
);
registerPublicCors(app, createPublicWebRateLimitMiddleware(publicRateLimiter));
registerMcpRequestGuard(app);
const nip98Revocations = createPostgresNip98RevocationStore();
const nip98RevocationGuard = createNip98RevocationGuard(nip98Revocations);
registerAuditRoutes(app, undefined, nip98RevocationGuard);
app.use(
  express.json({
    limit: "1mb",
    verify(req, _res, buffer) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use(nip98RevocationGuard);
const enterpriseEconomics = new EnterpriseEconomics(createPostgresEnterpriseEconomicsStore());
configureEnterpriseEconomics(enterpriseEconomics);
app.use(createEnterpriseEconomicsMiddleware(enterpriseEconomics));
registerCryptographicAuditRoutes(app, enterpriseEconomics, { ledger: revenueLedger });
registerCertifiedOracleRoutes(app, enterpriseEconomics);
registerNip98RevocationAdmin(app, nip98Revocations);
registerComplianceRoutes(app, nip98Revocations);

const macaroonUsageStore = createPostgresMacaroonUsageStore();

registerOpenApiRoute(app);
registerDocsRoutes(app);
registerMcpServerCardRoute(app);
// One Ed25519 identity signs the tool-description manifest and every async
// webhook callback, so receivers verify both with the same public key.
const toolIntegrityKey = loadToolIntegrityKey();
registerMcpRoute(app, {
  usageStore: macaroonUsageStore,
  ledger: revenueLedger,
  meshService,
  publicRateLimiter,
  asyncTaskRunner: createMcpAsyncTaskRunner({ signingKey: toolIntegrityKey }),
});
registerToolIntegrityRoute(app, mcpToolDefinitions, toolIntegrityKey);
registerNostrStatusRoute(app);
registerRevenueAnalyticsRoutes(app, revenueLedger);
registerSystemHealthRoute(app, pricingEngine);
registerLlmExportRoutes(app);
registerEnterpriseRoutes(app);
// server.ts starts scheduled OpenTimestamps anchoring after the first escrow
// recovery attempt; the first stamp waits until the boot has settled.
export const provenanceAnchoring = registerProvenanceRoutes(app);
registerZkDriftRoute(app);
registerEscrowRoutes(app, {
  signingKey: toolIntegrityKey,
  ready: () => escrowRecovery.whenReady(),
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
