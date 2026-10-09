import express, { type Express, type RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CreateEscrowBody, CreateEscrowResponse, SettleEscrowBody, SettleEscrowResponse,
  GetEscrowReceiptParams, GetEscrowReceiptResponse,
} from "@workspace/api-zod";
import { createL402Middleware } from "../middleware/l402";
import { createDefaultMultiSettlementRouter } from "../services/multiSettlement";
import { executeEscrow, type EscrowExecutor, type EscrowOperation } from "../services/escrowBridge";
import { fetchCurrentBitcoinTip } from "../services/epistemicGrounding";
import { mcpToolPrices } from "../lib/mcp-pricing";
import { mcpDiscoveryManifest } from "../lib/mcp-discovery-manifest";
import { openApiDocument } from "../openapi";
import type { MacaroonUsageStore } from "../lib/macaroon-usage-store";
import type { MacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import type { SettlementRouter } from "../services/settlement";

type EscrowOptions = {
  execute?: EscrowExecutor;
  readHeight?: () => Promise<number>;
  paymentGate?: RequestHandler;
  operatorSecret?: string;
  usageStore?: MacaroonUsageStore;
  revocationStore?: MacaroonRevocationStore;
  settlementRouter?: SettlementRouter;
  sessionSecret?: string;
};

/** Guard existing catalogs without registering, wrapping or changing MCP tools. */
export function assertEscrowMcpRegistryIntegrity(): void {
  const schemas = openApiDocument["x-mcp-tools"] as Record<string, unknown>;
  const names = Object.keys(mcpToolPrices).sort();
  if (names.length !== 15 || mcpDiscoveryManifest.mcp.capabilities.tools.count !== 15
      || JSON.stringify(names) !== JSON.stringify(Object.keys(schemas).sort())) {
    throw new Error("Escrow mount requires the unchanged 15-tool MCP catalog");
  }
}

export function registerEscrowRoutes(app: Express, options: EscrowOptions = {}): void {
  assertEscrowMcpRegistryIntegrity();
  const router = express.Router();
  const execute = options.execute ?? executeEscrow;
  const readHeight = options.readHeight ?? (async () => (await fetchCurrentBitcoinTip()).height);
  const operatorSecret = options.operatorSecret ?? process.env.MACAROON_OPERATOR_SECRET;
  const settlementRouter = options.settlementRouter ?? createDefaultMultiSettlementRouter();
  const gate = (suffix: string) => options.paymentGate ?? createL402Middleware({
    amountSats: 21,
    description: "Autonomous Escrow REST access (not escrow funding or toll collection)",
    scopePath: `/api/v1/escrow/${suffix}`,
    settlementRouter,
    sessionSecret: options.sessionSecret,
    usageStore: options.usageStore,
    revocationStore: options.revocationStore,
  });
  let active = 0;
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    // Existing paid routes advertise "macaroon"; this REST contract requires
    // the "token" alias. Adapt only escrow responses, not shared middleware.
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => setHeader(name,
      name.toLowerCase() === "www-authenticate" && typeof value === "string"
        ? value.replace(/^L402 macaroon="/, 'L402 token="')
        : value);
    next();
  });
  // L402 is an access fee, never authorization to release someone else's secret.
  const operatorGate: RequestHandler = (req, res, next) => {
    if (!operatorSecret) {
      res.status(503).json({ error: "Escrow operator authorization is not configured" });
      return;
    }
    const token = req.get("X-Escrow-Operator-Token") ?? "";
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(hash(token), hash(operatorSecret))) {
      res.status(403).json({ error: "Trusted escrow operator authorization is required" });
      return;
    }
    next();
  };
  const validate = (operation: EscrowOperation): RequestHandler => (req, res, next) => {
    const parsed = operation === "create"
      ? CreateEscrowBody.strict().safeParse(req.body)
      : operation === "settle"
        ? SettleEscrowBody.strict().safeParse(req.body)
        : GetEscrowReceiptParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid escrow fields" });
      return;
    }
    res.locals.escrowInput = parsed.data;
    next();
  };
  const run = (operation: EscrowOperation): RequestHandler => async (_req, res) => {
    if (active >= 8) {
      res.set("Retry-After", "5").status(503).json({ error: "Escrow service is busy" });
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    active++;
    try {
      const body = res.locals.escrowInput as Record<string, unknown>;
      let height: number | undefined;
      if (operation === "settle") {
        const lookup = await execute("lookup", { escrow_id: body.escrow_id }, undefined, controller.signal);
        if (lookup.status !== 200) {
          res.status(lookup.status).json(lookup.body);
          return;
        }
        if (lookup.body.status !== "LOCKED") {
          res.status(422).json({ error: "Settlement requires a LOCKED escrow" });
          return;
        }
        height = await readHeight();
        if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid strata height");
      }
      const result = await execute(operation, body, height, controller.signal);
      if (res.destroyed) return;
      if (result.status !== 200 && result.status !== 201) {
        res.status(result.status).json(result.body);
        return;
      }
      const output = operation === "create" ? CreateEscrowResponse.parse(result.body)
        : operation === "settle" ? SettleEscrowResponse.parse(result.body)
        : GetEscrowReceiptResponse.parse(result.body);
      if (operation === "receipt") res.type("application/ld+json");
      res.status(result.status).send(output);
    } catch {
      if (!res.destroyed) res.status(503).json({
        error: "Escrow service unavailable; a lost settlement response may require operator recovery",
      });
    } finally {
      active--;
      res.removeListener("close", abort);
    }
  };
  router.post("/create", validate("create"), gate("create"), operatorGate, run("create"));
  router.post("/settle", validate("settle"), gate("settle"), operatorGate, run("settle"));
  router.get("/receipt/:escrow_id", validate("receipt"), gate("receipt"), operatorGate, run("receipt"));
  app.use("/api/v1/escrow", router);
}
