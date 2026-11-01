// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { verifyRequestNip98Signer } from "../lib/nip98-request";
import { createSwarmReferralKey } from "../lib/swarm-referral";
import type { SwarmRoyalties } from "../lib/swarm-royalties";

export function registerSwarmReferralRoute(app: Express, royalties: SwarmRoyalties,
  options: { secret?: string; now?: () => number } = {}) {
  app.get("/api/swarm-referral-key", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const now = options.now?.() ?? Date.now();
    const signer = verifyRequestNip98Signer(req, now);
    if (!signer.provided || !signer.pubkey) {
      res.status(401).json({ error: "NIP98_AUTHENTICATION_REQUIRED" }); return;
    }
    const secret = options.secret ?? process.env.SESSION_SECRET;
    if (!secret) { res.status(503).json({ error: "REFERRAL_ISSUANCE_UNAVAILABLE" }); return; }
    try {
      const expiresAt = Math.floor(now / 1000) + 30 * 86400;
      res.json({ referral_key: createSwarmReferralKey(signer.pubkey, secret, expiresAt),
        agent_id: signer.pubkey, expires_at: expiresAt, discount_percent: 5, royalty_percent: 5,
        simulated: true, ...await royalties.balance(signer.pubkey) });
    } catch {
      res.status(503).json({ error: "ROYALTY_LEDGER_UNAVAILABLE" });
    }
  });
}
