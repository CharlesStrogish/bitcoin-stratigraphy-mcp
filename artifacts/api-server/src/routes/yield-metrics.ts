// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { createYieldMetricsReader } from "../lib/yield-metrics";

export function registerYieldMetricsRoutes(
  app: Express,
  read = createYieldMetricsReader(),
): void {
  app.all(["/yield-metrics.json", "/api/yield-metrics", "/api/yield-metrics.json"], async (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers": "X-Yield-Scope",
      "X-Yield-Scope": "mainnet-outbound",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.removeHeader("Access-Control-Allow-Credentials");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Headers", "*").status(204).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD, OPTIONS").status(405).json({ error: "Read-only public yield metrics" });
      return;
    }
    try {
      const metrics = await read();
      res.set("Cache-Control", "public, max-age=0, s-maxage=15, must-revalidate");
      res.status(200).json(metrics);
    } catch {
      res.set("Retry-After", "5").status(503).json({ error: "YIELD_METRICS_UNAVAILABLE" });
    }
  });
}
