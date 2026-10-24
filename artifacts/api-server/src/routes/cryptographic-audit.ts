// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash, type KeyObject } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import {
  canonical,
  issuerKeyId,
  loadArticle12IssuerKey,
  signIssuerPayload,
} from "../lib/article12-signature";
import {
  enterpriseContext,
  EXEMPTION_USD_CENTS,
  type EnterpriseEconomics,
} from "../lib/enterprise-economics";
import { createL402Middleware } from "../middleware/l402";
import {
  createDefaultSettlementRouter,
  type SettlementRouter,
} from "../services/settlement";
import type { RevenueLedger } from "../services/ledger";

export const CryptographicAuditInput = z
  .object({
    agent_decision: z
      .string()
      .min(1)
      .max(16_000)
      .refine((value) => value.trim().length > 0),
    stratigraphy_data_used: z.record(z.unknown()),
  })
  .strict();

export function createCryptographicAuditReceipt(
  input: z.infer<typeof CryptographicAuditInput>,
  key: KeyObject,
  now: number,
  exemptionExpiry: string | null = null,
): Record<string, unknown> {
  return signIssuerPayload(
    {
      receipt_type: "cryptographic_audit_receipt",
      provenance_type: "State-Anchored Provenance — submitted-data commitment",
      hash_algorithm: "SHA-256",
      commitment_sha256: createHash("sha256")
        .update(canonical(input), "utf8")
        .digest("hex"),
      issued_at: new Date(now).toISOString(),
      issuer_key_id: issuerKeyId(key),
      state_anchor_verified: false,
      agent_execution_proven: false,
      commercial_exemption_expiry_date: exemptionExpiry,
      verification_scope:
        "The issuer signed the submitted decision/data commitment; actual agent use and a Bitcoin state anchor are not verified.",
    },
    key,
    "cryptographic-audit-ed25519-v1",
    "bitcoin-stratigraphy/cryptographic-audit/v1\n",
  );
}

export function registerCryptographicAuditRoutes(
  app: Express,
  service: EnterpriseEconomics,
  options: {
    loadKey?: () => KeyObject;
    router?: SettlementRouter;
    ledger?: RevenueLedger;
  } = {},
): void {
  app.post("/api/v1/compliance/indemnity", (req, res) => {
    const parsed = CryptographicAuditInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Expected agent_decision string and stratigraphy_data_used object",
      });
      return;
    }
    if (Buffer.byteLength(canonical(parsed.data), "utf8") > 128 * 1_024) {
      res.status(413).json({ error: "Audit commitment input exceeds 128 KiB" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    try {
      const context = enterpriseContext.getStore();
      const exemption = service.token(context?.account);
      res.json({
        indemnity_receipt: createCryptographicAuditReceipt(
          parsed.data,
          (options.loadKey ?? loadArticle12IssuerKey)(),
          service.now(),
          exemption ? String(exemption.expiry_date) : null,
        ),
      });
    } catch (error) {
      req.log?.error?.(
        { err: error },
        "Cryptographic Audit Receipt unavailable",
      );
      res
        .status(503)
        .json({ error: "Cryptographic Audit Receipt unavailable" });
    }
  });

  app.get("/api/v1/compliance/commercial-exemption", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const context = enterpriseContext.getStore();
    if (!context?.buyer) {
      res
        .status(401)
        .json({ error: "Fresh NIP-98 buyer authentication required" });
      return;
    }
    res.json(service.describe(context));
  });

  const gate = createL402Middleware({
    now: service.now,
    settlementRouter: options.router ?? createDefaultSettlementRouter(),
    amountSats: (req) => Number(req.res!.locals.enterprisePurchaseSats),
    description:
      "Tier II Commercial Enterprise Exemption — funded annual qualifying volume",
    enforceCurrentAmount: false,
    scopePath: "/api/v1/compliance/commercial-exemption/purchase",
    ledger: options.ledger,
  });
  app.post(
    "/api/v1/compliance/commercial-exemption/purchase",
    async (req, res, next) => {
      if (!enterpriseContext.getStore()?.buyer) {
        res
          .status(401)
          .json({ error: "Fresh NIP-98 buyer authentication required" });
        return;
      }
      const price = await service.readPrice();
      if (!price || !Number.isSafeInteger(price) || price <= 0) {
        res.status(503).json({
          error: "Current BTC/USD price unavailable; no exemption granted",
        });
        return;
      }
      res.locals.enterprisePurchaseSats = Number(
        (BigInt(EXEMPTION_USD_CENTS) * 100_000_000n + BigInt(price) - 1n) /
          BigInt(price),
      );
      await gate(req, res, next);
    },
    (_req, res) => {
      const context = enterpriseContext.getStore()!;
      res.setHeader("Cache-Control", "no-store");
      res.json({ funded_purchase: true, ...service.describe(context) });
    },
  );
}
