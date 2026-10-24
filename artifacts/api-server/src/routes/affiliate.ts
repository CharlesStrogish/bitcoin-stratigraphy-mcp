// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { z } from "zod";
import type { EnterpriseEconomics } from "../lib/enterprise-economics";
import {
  verifyRequestNip98Signer,
  requestNip98Authorization,
} from "../lib/nip98-request";
import { parseAgentPayout } from "../middleware/enterprise-economics";
import {
  AffiliateProofError,
  verifyAffiliate,
  affiliateBalance,
} from "../lib/affiliate-security";
import type { ProviderReader } from "../lib/affiliate-provider";

export function registerAffiliateRoutes(
  app: Express,
  service: EnterpriseEconomics,
  options: { readProvider?: ProviderReader } = {},
): void {
  app.post("/api/v1/affiliate/verify", async (req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    const body = z
      .object({ agent_id: z.string().min(1).max(2048) })
      .strict()
      .safeParse(req.body);
    let agent: string | undefined;
    try {
      if (body.success) agent = parseAgentPayout(undefined, body.data.agent_id);
    } catch {}
    if (!agent) {
      res
        .status(400)
        .json({
          error: "Provide only agent_id as a Lightning address or LNURL",
        });
      return;
    }
    const signature = verifyRequestNip98Signer(req, service.now());
    if (!signature.provided || !signature.pubkey) {
      res
        .status(401)
        .json({
          error:
            "Fresh NIP-98 signature over this POST URL and exact body required",
        });
      return;
    }
    try {
      const event = JSON.parse(
        Buffer.from(
          requestNip98Authorization(req)!.slice(6),
          "base64",
        ).toString(),
      );
      const verification = await verifyAffiliate(
        service,
        agent,
        signature.pubkey,
        event.id,
        options.readProvider,
      );
      res.json({
        verification,
        balance: await affiliateBalance(service, agent),
      });
    } catch (error) {
      if (error instanceof AffiliateProofError) {
        res.status(403).json({ error: error.message, reward_state: "pending" });
      } else {
        req.log?.warn?.(
          "Automated affiliate ownership verification unavailable",
        );
        res
          .status(503)
          .json({
            error:
              "Provider ownership record or ledger unavailable; rewards remain pending",
          });
      }
    }
  });
  app.get(
    "/api/v1/affiliate/balance/:agent_id",
    async (req, res): Promise<void> => {
      res.set("Cache-Control", "no-store");
      let agent: string | undefined;
      try {
        if (typeof req.params.agent_id === "string")
          agent = parseAgentPayout(undefined, req.params.agent_id);
      } catch {}
      if (!agent) {
        res.status(400).json({ error: "Invalid agent_id" });
        return;
      }
      try {
        const { allocations: _privateInvoiceHistory, ...balance } =
          await affiliateBalance(service, agent);
        res.json(balance);
      } catch {
        res.status(503).json({ error: "Affiliate accounting unavailable" });
      }
    },
  );
}
