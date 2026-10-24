// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { EnterpriseEconomics } from "../lib/enterprise-economics";
import { verifyRequestNip98Signer } from "../lib/nip98-request";
import { parseAgentPayout } from "../middleware/enterprise-economics";

export function registerOracleCrlRoutes(
  app: Express,
  service: EnterpriseEconomics,
  operatorSecret = process.env.MACAROON_OPERATOR_SECRET,
): void {
  app.get("/api/v1/compliance/crl", async (_req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    try {
      res.json(
        await service.store.transaction("oracle-crl", (tx) => tx.revocations()),
      );
    } catch {
      res
        .status(503)
        .json({
          error: "Revocation list unavailable; do not trust cached credentials",
        });
    }
  });
  app.post("/api/v1/compliance/crl", async (req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    const parsed = z
      .object({ agent_id: z.string().min(1).max(2048) })
      .strict()
      .safeParse(req.body);
    let agent: string | undefined;
    try {
      if (parsed.success)
        agent = /^urn:sha256:[0-9a-f]{64}$/.test(parsed.data.agent_id)
          ? parsed.data.agent_id
          : parseAgentPayout(undefined, parsed.data.agent_id);
    } catch {}
    if (!agent) {
      res
        .status(400)
        .json({
          error: "Provide only agent_id as an address, LNURL or credential jti",
        });
      return;
    }
    const digest = (s: string) => createHash("sha256").update(s).digest();
    const operator =
      Boolean(operatorSecret) &&
      timingSafeEqual(
        digest(req.get("Authorization") ?? ""),
        digest("Bearer " + operatorSecret),
      );
    try {
      if (!operator) {
        const signer = verifyRequestNip98Signer(req, service.now());
        const profile = await service.store.transaction(
          "affiliate:" + agent,
          (tx) => tx.security("affiliate:" + agent),
        );
        if (
          !signer.provided ||
          !signer.pubkey ||
          profile?.pubkey !== signer.pubkey ||
          typeof profile.expires_at !== "number" ||
          profile.expires_at <= service.now()
        ) {
          res
            .status(403)
            .json({
              error:
                "Verified address-owner signature or operator authorization required",
            });
          return;
        }
      }
      await service.store.transaction("oracle-crl", (tx) =>
        tx.revoke(agent!, new Date(service.now()).toISOString()),
      );
      res.json({ revoked: true, agent_id: agent });
    } catch {
      res.status(503).json({ error: "Revocation could not be persisted" });
    }
  });
}
