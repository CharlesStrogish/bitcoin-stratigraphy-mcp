// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { type Express, type RequestHandler } from "express";
import { ScanArticle12PromptBody, ScanArticle12PromptResponse, MintScannerMacaroonResponse } from "@workspace/api-zod";
import { analyzeScannerPrompt, scannerPromptHash } from "../lib/scanner";
import { createL402Middleware, parseL402Header } from "../middleware/l402";
import { createDefaultMultiSettlementRouter } from "../services/multiSettlement";
import type { SettlementRouter } from "../services/settlement";
import type { MacaroonUsageStore } from "../lib/macaroon-usage-store";
import type { MacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import type { RevenueLedger } from "../services/ledger";
import { createMemoryMacaroonUsageStore } from "../lib/macaroon-usage-store";
import { SCANNER_RETAIL_SATS, scannerDescription } from "../lib/scanner-credits";
import { btcSpotOracle, usdToSats, type SpotOracle } from "../services/btcSpotOracle";
import { inspectSubscriptionMacaroon } from "../lib/subscription-pass";

export type ScannerRouteOptions = {
  settlementRouter?: SettlementRouter;
  sessionSecret?: string;
  usageStore?: MacaroonUsageStore;
  revocationStore?: MacaroonRevocationStore;
  ledger?: RevenueLedger;
  spotOracle?: SpotOracle;
};

function scannerPaymentOptions(options: ScannerRouteOptions) {
  return {
    settlementRouter: options.settlementRouter ?? createDefaultMultiSettlementRouter(),
    sessionSecret: options.sessionSecret,
    usageStore: options.usageStore ?? createMemoryMacaroonUsageStore(),
    revocationStore: options.revocationStore,
    ledger: options.ledger,
    invoiceExpirySeconds: 900,
    enforceCurrentAmount: true,
  };
}

export function registerScannerRoute(app: Express, options: ScannerRouteOptions = {}): void {
  const shared = scannerPaymentOptions(options);
  const gate = createL402Middleware({
    ...shared,
    amountSats: SCANNER_RETAIL_SATS,
    scannerCredits: "redeem",
    description: "Article 12 heuristic prompt risk review (simulated receipt)",
    // Bind payment to the exact prompt bytes, not merely the public route.
    scopePath: (req) => `/api/scanner/${scannerPromptHash(req.body.prompt)}`,
    expectedOutputSchema: {
      type: "object",
      description: "Heuristic prompt risk report; SHA-256 simulated receipt, not a ZK proof.",
      required: ["overall_risk_level", "flagged_categories", "compliance_hash", "receipt_type"],
      properties: {
        overall_risk_level: { type: "string", enum: ["Low", "Medium", "High"] },
        flagged_categories: { type: "array", items: { type: "object" } },
        compliance_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        receipt_type: { type: "string", const: "simulated_zk_receipt" },
      },
    },
  });
  const validate: RequestHandler = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const parsed = ScanArticle12PromptBody.strict().safeParse(req.body);
    if (!parsed.success || parsed.data.prompt.trim().length < 20 ||
        req.get("X-Requested-Budget") || req.get("X-L402-Batch-Size") ||
        req.get("X-Swarm-Referral")) {
      res.status(400).json({ error: "Provide a 20–20000 character prompt. Batch, budget and referral modes are not supported by this kiosk." });
      return;
    }
    req.body = parsed.data;
    next();
  };
  app.post("/api/scanner", validate, gate, (req, res): void => {
    res.json(ScanArticle12PromptResponse.parse(analyzeScannerPrompt(req.body.prompt)));
  });

  app.post("/api/mint-macaroon", createScannerMintHandler({ ...shared, spotOracle: options.spotOracle }));
}

/** Same product, scope, price and verifier on normal and disaster-recovery rails. */
export function createScannerMintHandler(
  options: ScannerRouteOptions = {},
  fiatContinuity = false,
): RequestHandler {
  const shared = scannerPaymentOptions(options);
  const gates = new Map<string, RequestHandler>();
  return async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if ((req.body !== undefined && (typeof req.body !== "object" || req.body === null ||
        Array.isArray(req.body) || Object.keys(req.body).some(key => key !== "pack") ||
        (req.body.pack !== undefined && req.body.pack !== "heavy_swarm_1000"))) ||
        req.get("X-Requested-Budget") || req.get("X-L402-Batch-Size") ||
        req.get("X-Swarm-Referral")) {
      res.status(400).json({ error: "Provide an empty object or pack: heavy_swarm_1000; batch, budget and referral headers are not supported" });
      return;
    }
    const credits = req.body?.pack === "heavy_swarm_1000" ? 1000 : 100;
    const credential = parseL402Header(req.header("Authorization"), true);
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    const pass = credential && secret ? inspectSubscriptionMacaroon(credential.macaroon, secret) : null;
    if (req.get("Authorization") && (!pass?.scannerCredits || pass.scannerCredits !== credits)) {
      res.status(401).json({ error: "Invalid scanner pack credential" }); return;
    }
    try {
      // Paid credentials use their issuer-bound price, never today's spot quote.
      const amount = pass ? pass.amountMsats! / 1000 :
        usdToSats(credits === 1000 ? 4000 : 450, (await (options.spotOracle ?? btcSpotOracle).quote()).btcUsd);
      const key = `${credits}:${amount}`;
      let gate = gates.get(key);
      if (!gate) {
        gate = createL402Middleware({ ...shared, fiatContinuity, amountSats: amount,
          description: scannerDescription(credits), scopePath: "/api/scanner", scannerCredits: "mint",
          scannerPack: { credits, seconds: (credits === 1000 ? 90 : 30) * 86400 } });
        if (gates.size >= 256) gates.delete(gates.keys().next().value!);
        gates.set(key, gate);
      }
      await gate(req, res, (error?: unknown) => {
        if (error) { next(error); return; }
        res.json(MintScannerMacaroonResponse.parse({ macaroon: credential!.macaroon,
          credits: res.locals.l402.credits, amount_sats: pass!.amountMsats! / 1000,
          valid_until: res.locals.l402.validUntil, scope: "/api/scanner" }));
      });
    } catch {
      if (!res.headersSent) res.status(503).json({ error: "btc_spot_oracle_unavailable" });
    }
  };
}
