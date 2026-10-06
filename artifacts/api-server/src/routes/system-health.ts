// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import type { PricingEngine } from "../services/pricing";
import {
  getRuntimeSnapshot,
  runtimePricingLoad,
} from "../services/orchestrator";
import { getRelayPoolHealth } from "../services/relayPool";

export function registerSystemHealthRoute(
  app: Express,
  pricingEngine: PricingEngine,
): void {
  app.get("/api/v1/system/health", (_req, res): void => {
    const runtime = getRuntimeSnapshot();
    const quote = pricingEngine.jobQuote?.(
      "stratigraphy",
      runtimePricingLoad(),
    );
    const memory = process.memoryUsage();
    const relayPool = getRelayPoolHealth();
    const queuePressure =
      (runtime.activeWorkers + runtime.queuedJobs) /
      Math.max(1, runtime.maxWorkers);
    const status =
      relayPool.totalRelays > 0 && relayPool.healthyRelays === 0
        ? "unhealthy"
        : !runtime.dvmRunning ||
            relayPool.healthyRelays < relayPool.totalRelays ||
            queuePressure >= 0.7 ||
            runtime.cpuUtilization >= 0.9
          ? "degraded"
          : "ok";
    res.status(200).json({
      status,
      relayPool,
      activeWorkerCount: runtime.activeWorkers,
      queuedJobCount: runtime.queuedJobs,
      dynamicFeeMultiplier: quote?.multiplier ?? 1,
      cpuUtilization: runtime.cpuUtilization,
      memoryUsage: {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
      },
    });
  });
}
