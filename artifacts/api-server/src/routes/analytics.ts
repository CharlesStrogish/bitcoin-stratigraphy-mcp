// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express, Request, Response } from "express";
import type { RevenueLedger } from "../services/ledger";

export function registerRevenueAnalyticsRoutes(
  app: Express,
  ledger: RevenueLedger,
): void {
  app.get(
    "/api/v1/analytics/revenue",
    async (_req: Request, res: Response): Promise<void> => {
      try {
        const [totalVolumeSats, volume24hSats, channelBreakdown, goal] =
          await Promise.all([
            ledger.getTotalVolume(),
            ledger.getDailyVolume(),
            ledger.getChannelBreakdown(),
            ledger.getGoalProgress(500_000),
          ]);
        res.status(200).json({
          totalVolumeSats,
          volume24hSats,
          channelBreakdown,
          dailyGoal: goal,
        });
      } catch {
        res.status(503).json({ error: "Revenue analytics unavailable" });
      }
    },
  );

  app.get(
    "/api/v1/analytics/audit",
    async (req: Request, res: Response): Promise<void> => {
      const rawLimit =
        typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
        res.status(400).json({ error: "limit must be an integer from 1 to 500" });
        return;
      }
      try {
        res.status(200).json({ transactions: await ledger.getRecent(rawLimit) });
      } catch {
        res.status(503).json({ error: "Revenue audit unavailable" });
      }
    },
  );
}