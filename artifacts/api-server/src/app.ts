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

const app: Express = express();

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
app.use(
  cors({
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
  }),
);
app.use(
  express.json({
    verify(req, _res, buffer) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

registerOpenApiRoute(app);
registerMcpServerCardRoute(app);
registerMcpRoute(app);
registerNostrStatusRoute(app);
app.use("/api", router);
registerStratigraphyRoutes(
  app,
  undefined,
  undefined,
  createPostgresPaymentChallengeStore(),
  createPostgresMacaroonUsageStore(),
  createPostgresMacaroonRevocationStore(),
);

export default app;
