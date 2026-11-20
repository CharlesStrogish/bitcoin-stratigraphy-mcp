// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { pool } from "@workspace/db";
import { createWaiverService, WaiverError } from "../services/agplWaivers";
import { createPostgresWaiverStore } from "../services/agplWaiverStore";
import { SettlementKeyError } from "../services/btcAddressDeriver";
import { createHash } from "node:crypto";
import { clientKey } from "../lib/client-address";

export function registerAgplWaiverRoutes(app: Express, service = createWaiverService({ store: createPostgresWaiverStore(pool) })) {
  for (const operation of ["quote", "claim"] as const) {
    app.post(`/api/v1/waivers/${operation}`, async (req, res): Promise<void> => {
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      try { res.json(operation === "quote"
        ? await service.quote(req.body, createHash("sha256").update(clientKey(req)).digest("hex"))
        : await service.claim(req.body)); }
      catch (error) {
        const oracle = (error as {code?:string}).code === "btc_spot_oracle_unavailable";
        if (error instanceof WaiverError && error.status === 429)
          res.set("Retry-After", String(error.details.retry_after));
        res.status(error instanceof WaiverError || error instanceof SettlementKeyError ? error.status : 503)
          .json({ error: error instanceof WaiverError || error instanceof SettlementKeyError ? error.message : oracle ? "btc_spot_oracle_unavailable" : "waiver_service_unavailable",
            ...(error instanceof WaiverError ? error.details : {}) });
      }
    });
  }
}
