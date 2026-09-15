import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { registerStratigraphyRoutes } from "./routes/stratigraphy";
import { registerOpenApiRoute } from "./routes/openapi";
import { registerMcpRoute } from "./routes/mcp";
import { registerMcpServerCardRoute } from "./routes/mcp-server-card";
import { logger } from "./lib/logger";
import { createPostgresPaymentChallengeStore } from "./lib/postgres-payment-challenge-store";

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
app.use(cors({ exposedHeaders: ["WWW-Authenticate"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

registerOpenApiRoute(app);
registerMcpServerCardRoute(app);
registerMcpRoute(app);
app.use("/api", router);
registerStratigraphyRoutes(
  app,
  undefined,
  undefined,
  createPostgresPaymentChallengeStore(),
);

export default app;
