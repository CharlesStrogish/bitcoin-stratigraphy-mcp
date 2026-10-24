// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import {
  certifiedOracleStatus,
  ORACLE_THRESHOLD_USD_CENTS,
} from "../lib/certified-oracle";
import type { EnterpriseEconomics } from "../lib/enterprise-economics";
import { parseAgentPayout } from "../middleware/enterprise-economics";

export function registerCertifiedOracleRoutes(
  app: Express,
  service: EnterpriseEconomics,
): void {
  app.get(
    "/api/v1/compliance/certified-oracle/:agent_id",
    async (req, res): Promise<void> => {
      res.setHeader("Cache-Control", "no-store");
      const raw = req.params.agent_id;
      let payout: string | undefined;
      try {
        if (typeof raw !== "string")
          throw new Error("Invalid routing identifier");
        payout = parseAgentPayout(undefined, raw);
        if (!payout) throw new Error("Empty routing identifier");
      } catch {
        res.status(400).json({
          error: "agent_id must be a URL-encoded Lightning address or LNURL",
        });
        return;
      }
      try {
        const result = await certifiedOracleStatus(service, payout);
        if (!result.eligible) {
          res.status(404).json({
            eligible: false,
            agent_id: payout,
            cumulative_routed_msats: result.volume,
            threshold_usd: ORACLE_THRESHOLD_USD_CENTS / 100,
            error: "Insufficient confirmed direct routing volume",
          });
          return;
        }
        res.json(result.credential);
      } catch (error) {
        req.log?.error?.(
          { err: error },
          "Certified Oracle credential unavailable",
        );
        res.status(503).json({
          error:
            "Certified Oracle accounting, current quote, or signing unavailable",
        });
      }
    },
  );
}
