// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import express, { type Express, type RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CreateEscrowBody, CreateEscrowResponse, SettleEscrowBody, SettleEscrowResponse,
  GetEscrowReceiptParams, GetEscrowReceiptResponse,
  GetEscrowTollResponse,
  GetEscrowLedgerStatsResponse, GetEscrowGenesisReceiptResponse,
} from "@workspace/api-zod";
import { readGenesisReceipt } from "../services/escrowLedger";
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
import { escrowTollQuote, readEscrowBitcoinPrice } from "../services/escrowPricing";
import { escrowCapability, verifyEscrowCapability } from "../lib/escrow-capability";

type EscrowOptions = {
  execute?: EscrowExecutor;
  /**
   * Startup recovery gate. Every escrow route waits for it; a rejection is an
   * explicit 503 so an unrecovered ledger is never served as zero or empty.
   */
  ready?: () => Promise<void>;
  readHeight?: () => Promise<number>;
  readPrice?: () => Promise<number | null>;
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
  if (names.length !== 16 || mcpDiscoveryManifest.mcp.capabilities.tools.count !== 16
      || JSON.stringify(names) !== JSON.stringify(Object.keys(schemas).sort())) {
    throw new Error("Escrow mount requires the canonical 16-tool MCP catalog");
  }
}

export function registerEscrowRoutes(app: Express, options: EscrowOptions = {}): void {
  assertEscrowMcpRegistryIntegrity();
  const router = express.Router();
  const ready = options.ready;
  if (ready) {
    router.use(async (_req, res, next) => {
      try {
        await ready();
      } catch {
        if (!res.destroyed) {
          res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Retry-After": "5" })
            .status(503).json({ error: "Durable escrow ledger is recovering" });
        }
        return;
      }
      next();
    });
  }
  const execute = options.execute ?? executeEscrow;
  const readHeight = options.readHeight ?? (async () => (await fetchCurrentBitcoinTip()).height);
  const readPrice = options.readPrice ?? readEscrowBitcoinPrice;
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
  // The settlement route charges the reserved protocol toll, not an additional
  // fixed access fee. Bind the paid capability to the entire exact submission.
  const tollGate = createL402Middleware({
    amountSats: (req) => Number(req.res?.locals.escrowTollSats),
    enforceCurrentAmount: true,
    description: "Autonomous Escrow execution settlement toll",
    scopePath: (req) => `/api/v1/escrow/settle/${createHash("sha256")
      .update(JSON.stringify([
        req.body.escrow_id, req.body.execution_trace, req.body.result_payload,
      ])).digest("hex")}`,
    settlementRouter,
    sessionSecret: options.sessionSecret,
    usageStore: options.usageStore,
    revocationStore: options.revocationStore,
  });
  const prepareSettlement: RequestHandler = async (_req, res, next) => {
    if (active >= 8) {
      res.set("Retry-After", "5").status(503).json({ error: "Escrow service is busy" });
      return;
    }
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const body = res.locals.escrowInput as Record<string, unknown>;
      const lookup = await execute("lookup", { escrow_id: body.escrow_id }, undefined, controller.signal);
      if (lookup.status !== 200) {
        res.status(lookup.status).json(lookup.body);
        return;
      }
      if (lookup.body.status !== "LOCKED") {
        res.status(422).json({ error: "Settlement requires a LOCKED escrow" });
        return;
      }
      const toll = lookup.body.toll_fee_sats;
      if (!Number.isSafeInteger(toll) || Number(toll) <= 0) throw new Error("Invalid toll");
      res.locals.escrowTollSats = toll;
      const height = await readHeight();
      if (!Number.isSafeInteger(height) || height < 0) throw new Error("Invalid strata height");
      res.locals.escrowHeight = height;
    } catch {
      if (!res.destroyed) res.status(503).json({ error: "Escrow toll or chain lookup unavailable" });
      return;
    } finally {
      active--;
      res.removeListener("close", abort);
    }
    if (!res.destroyed) next();
  };
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
  // Public L402 access never grants redemption of somebody else's escrow.
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
  const optionalOperator: RequestHandler = (req, res, next) => {
    if (req.get("X-Escrow-Operator-Token")) operatorGate(req, res, next);
    else next();
  };
  const settlementAccess: RequestHandler = (req, res, next) => {
    if (req.get("X-Escrow-Operator-Token")) {
      operatorGate(req, res, next);
      return;
    }
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    if (!secret) {
      res.status(503).json({ error: "Escrow capability signing is unavailable" });
      return;
    }
    if (!verifyEscrowCapability(secret, req.body.escrow_id, req.body.settlement_capability)) {
      res.status(403).json({ error: "The creator-held settlement capability is required" });
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
    // The capability authorizes transport only; a body agent_id is read by the
    // toll gate and reaches the engine only through the paid macaroon caveat.
    const { settlement_capability: _capability, agent_id: _agent, ...input } =
      parsed.data as Record<string, unknown>;
    res.locals.escrowInput = input;
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
        height = res.locals.escrowHeight;
        if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) throw new Error("Invalid strata height");
      }
      const result = await execute(operation, body, height, controller.signal,
        operation === "settle" ? {
          payment_hash: res.locals.l402.paymentHash,
          amount_sats: res.locals.escrowTollSats,
          provider: res.locals.l402.provider,
          confirmed_at: new Date().toISOString(),
        } : undefined,
        // Only the verified agent caveats attribute a settlement.
        operation === "settle" && res.locals.l402.agentId !== undefined ? {
          agentId: res.locals.l402.agentId,
          ...(res.locals.l402.agentAuthentication === undefined ? {}
            : { authentication: res.locals.l402.agentAuthentication }),
        } : undefined);
      if (res.destroyed) return;
      if (result.status !== 200 && result.status !== 201) {
        res.status(result.status).json(result.body);
        return;
      }
      if (operation === "create") {
        const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
        if (!secret) throw new Error("Escrow capability signing is unavailable");
        result.body.settlement_capability = escrowCapability(secret, String(result.body.escrow_id));
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
  // Public, read-only price preview. Never creates an escrow or collects a fee.
  router.get("/stats", async (_req, res) => {
    if (active >= 8) {
      res.set("Retry-After", "5").status(503).json({ error: "Escrow service is busy" });
      return;
    }
    active++;
    try {
      const result = await execute("stats", {});
      if (result.status !== 200) throw new Error("Escrow ledger unavailable");
      res.json(GetEscrowLedgerStatsResponse.parse(result.body));
    } catch {
      res.status(503).json({ error: "Durable escrow ledger unavailable" });
    } finally {
      active--;
    }
  });
  router.get("/genesis-receipt", async (_req, res) => {
    try {
      res.json(GetEscrowGenesisReceiptResponse.parse(await readGenesisReceipt()));
    } catch {
      res.status(503).json({ error: "Durable escrow ledger unavailable" });
    }
  });
  router.get("/toll", async (_req, res) => {
    const price = await readPrice().catch(() => null);
    if (!res.destroyed) res.json(GetEscrowTollResponse.parse(escrowTollQuote(price)));
  });
  router.post("/create", validate("create"), optionalOperator, gate("create"), run("create"));
  router.post("/settle", validate("settle"), settlementAccess, prepareSettlement, tollGate, run("settle"));
  router.get("/receipt/:escrow_id", validate("receipt"), gate("receipt"), operatorGate, run("receipt"));
  app.use("/api/v1/escrow", router);
}
