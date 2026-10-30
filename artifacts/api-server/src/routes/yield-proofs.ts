// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { publicYieldLedger } from "../lib/public-yield-ledger";

export function registerYieldProofRoutes(
  app: Express,
  ledger: Pick<typeof publicYieldLedger, "snapshot"> = publicYieldLedger,
): void {
  app.all(["/yield-proofs.json", "/api/yield-proofs.json"], (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Yield-Ledger-Source": "process-local-confirmed-payout-scaffold",
      "X-Yield-Ledger-Retention": "24 hours; at most 256 records; resets on restart",
      "X-Yield-Proof-Semantics":
        "Public-record SHA-256 commitment and allocation arithmetic only; not independent Lightning settlement, ZK, or Bitcoin-inclusion proof",
    });
    res.removeHeader("Access-Control-Allow-Credentials");
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Headers", "*").status(204).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD, OPTIONS");
      res.status(405).json({ error: "Read-only public yield ledger" });
      return;
    }
    res.status(200).json(ledger.snapshot());
  });
}
