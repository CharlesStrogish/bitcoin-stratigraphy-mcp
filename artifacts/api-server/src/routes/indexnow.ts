// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";

// Public ownership-verification token, not a payment or authentication secret.
export const INDEXNOW_KEY = "dda40963db91d1bc282dd6756b30829c";

export function registerIndexNowRoute(app: Express): void {
  app.all(`/${INDEXNOW_KEY}.txt`, (req, res) => {
    res.set("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD").status(405).end();
      return;
    }
    res.status(200).type("text/plain").send(INDEXNOW_KEY);
  });
}
