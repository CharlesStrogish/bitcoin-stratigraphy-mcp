// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express, RequestHandler } from "express";
import { ScanArticle12PromptBody, ScanArticle12PromptResponse } from "@workspace/api-zod";
import { analyzeScannerPrompt, scannerPromptHash } from "../lib/scanner";
import { createL402Middleware } from "../middleware/l402";
import { createDefaultMultiSettlementRouter } from "../services/multiSettlement";
import type { SettlementRouter } from "../services/settlement";
import type { MacaroonUsageStore } from "../lib/macaroon-usage-store";
import type { MacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import type { RevenueLedger } from "../services/ledger";

export function registerScannerRoute(app: Express, options: {
  settlementRouter?: SettlementRouter;
  sessionSecret?: string;
  usageStore?: MacaroonUsageStore;
  revocationStore?: MacaroonRevocationStore;
  ledger?: RevenueLedger;
} = {}): void {
  const gate = createL402Middleware({
    amountSats: 21,
    description: "Article 12 heuristic prompt risk review (simulated receipt)",
    // Bind payment to the exact prompt bytes, not merely the public route.
    scopePath: (req) => `/api/scanner/${scannerPromptHash(req.body.prompt)}`,
    settlementRouter: options.settlementRouter ?? createDefaultMultiSettlementRouter(),
    sessionSecret: options.sessionSecret,
    usageStore: options.usageStore,
    revocationStore: options.revocationStore,
    ledger: options.ledger,
    invoiceExpirySeconds: 900,
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
}
