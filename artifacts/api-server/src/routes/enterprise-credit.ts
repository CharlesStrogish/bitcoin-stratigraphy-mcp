// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import {
  CREDIT_TAB_PATH,
  FLEET_REGISTER_PATH,
  CreditTabError,
  verifiedCreditIdentity,
  type EnterpriseCreditTabs,
} from "../lib/enterprise-credit-tabs";
import type { SettlementRouter } from "../services/settlement";
import type { RevenueLedger } from "../services/ledger";
import { requestNip98Authorization } from "../lib/nip98-request";

export function registerEnterpriseCreditRoutes(
  app: Express,
  options: {
    tabs: EnterpriseCreditTabs;
    router: SettlementRouter;
    sessionSecret?: string;
    ledger?: RevenueLedger;
  },
) {
  app.all(
    [
      FLEET_REGISTER_PATH,
      CREDIT_TAB_PATH,
      CREDIT_TAB_PATH + "/close",
      CREDIT_TAB_PATH + "/settle",
    ],
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const pubkey = verifiedCreditIdentity(req);
        if (req.path === FLEET_REGISTER_PATH) {
          if (req.method !== "POST") {
            res.status(405).setHeader("Allow", "POST");
            res.json({ error: "Use POST for fleet registration" });
            return;
          }
          const event = JSON.parse(
            Buffer.from(
              requestNip98Authorization(req)!.slice(6),
              "base64",
            ).toString(),
          );
          res.json(
            await options.tabs.registerFleet(pubkey, req.body, event.id),
          );
          return;
        }
        const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
        if (!secret)
          throw new CreditTabError(503, "Credit tab signing unavailable");
        if (req.path === CREDIT_TAB_PATH && req.method === "GET") {
          res.json(await options.tabs.status(pubkey));
          return;
        }
        if (
          req.method !== "POST" ||
          !["/close", "/settle"].some(
            (suffix) => req.path === CREDIT_TAB_PATH + suffix,
          )
        ) {
          res
            .status(405)
            .json({ error: "Use GET for status or POST for close/settle" });
          return;
        }
        if (
          req.path.endsWith("/settle") &&
          /^L402\b/.test(req.get("Authorization") ?? "")
        ) {
          res.json(
            await options.tabs.settle(
              pubkey,
              req.get("Authorization"),
              options.router,
              secret,
              options.ledger,
            ),
          );
          return;
        }
        const invoice = await options.tabs.invoice(
          pubkey,
          options.router,
          secret,
        );
        if ("invoice" in invoice && "macaroon" in invoice)
          res.setHeader(
            "WWW-Authenticate",
            `L402 macaroon="${invoice.macaroon}", invoice="${invoice.invoice}"`,
          );
        res.status("invoice" in invoice ? 402 : 200).json(invoice);
      } catch (error) {
        if (!(error instanceof CreditTabError))
          req.log?.error({ err: error }, "Credit tab operation failed");
        res.status(error instanceof CreditTabError ? error.status : 503).json({
          error:
            error instanceof CreditTabError
              ? error.message
              : "Credit tab storage or settlement unavailable",
        });
      }
    },
  );
}
