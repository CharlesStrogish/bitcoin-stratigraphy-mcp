// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { z } from "zod";
import { inspectSubscriptionMacaroon } from "../lib/subscription-pass";
import { logger } from "../lib/logger";
import { YieldClaimError, type PrivateYieldEarnings } from "../lib/private-yield-earnings";
import { AgentYieldInvariantError } from "../lib/agent-yield-invariant";
import { parseYieldWithdrawalInvoice } from "../lib/yield-withdrawal-invoice";
import { verifyRequestNip98Signer } from "../lib/nip98-request";
import { createHash, timingSafeEqual } from "node:crypto";
import { scheduleYieldBroadcast, type YieldBroadcast } from "../services/yieldOracle";

const claimInput = z.object({
  macaroons: z.array(z.string().min(1).max(16384)).max(32).default([]),
  royalty_payment_hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(32).optional(),
  bolt11_invoice: z.string().min(100).max(4096),
}).strict().refine(value => value.macaroons.length + (value.royalty_payment_hashes?.length ?? 0) >= 1 &&
  value.macaroons.length + (value.royalty_payment_hashes?.length ?? 0) <= 32);

export function registerClaimYieldRoute(
  app: Express,
  ledger: PrivateYieldEarnings,
  options: { secret?: string; now?: () => number; logSettlement?: (claim: Record<string, unknown>) => void;
    operatorSecret?: string; broadcastYield?: YieldBroadcast } = {},
): void {
  app.post("/api/claim-yield", async (req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    const parsed = claimInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "INVALID_CLAIM_PAYLOAD" });
      return;
    }
    const secret = options.secret ?? process.env.SESSION_SECRET;
    if (!secret) { res.status(503).json({ error: "CLAIM_VERIFICATION_UNAVAILABLE" }); return; }
    let royaltyOwner: string | undefined;
    if (parsed.data.royalty_payment_hashes?.length) {
      const signer = verifyRequestNip98Signer(req, options.now?.() ?? Date.now());
      if (!signer.provided || !signer.pubkey) {
        res.status(401).json({ error: "NIP98_AUTHENTICATION_REQUIRED" }); return;
      }
      try {
        if (await req.app.locals.swarmReferralRevoked?.(signer.pubkey)) {
          res.status(403).json({ error: "ROYALTY_OWNER_REVOKED" }); return;
        }
      } catch {
        res.status(503).json({ error: "ROYALTY_IDENTITY_UNAVAILABLE" }); return;
      }
      royaltyOwner = signer.pubkey;
    }
    // Historical bearer receipts, not renewed API authorization: expiry/quota are
    // irrelevant here. HMAC integrity and exact confirmed settlement remain mandatory.
    const passes = parsed.data.macaroons.map(macaroon => inspectSubscriptionMacaroon(macaroon, secret));
    if (passes.some(pass => !pass || pass.paymentAsset !== "btc-lightning" ||
        !pass.paymentProvider || !pass.amountMsats || !pass.allowedPaths.length)) {
      res.status(403).json({ error: "INVALID_PAID_RECEIPT" });
      return;
    }
    let invoice;
    try {
      // The ledger rejects expired NEW attempts. Parsing here without a current
      // expiry cutoff lets a lost-response retry recover an existing pending ID.
      invoice = parseYieldWithdrawalInvoice(parsed.data.bolt11_invoice, 0);
    } catch {
      res.status(400).json({ error: "INVALID_OR_EXPIRED_BOLT11_INVOICE" });
      return;
    }
    try {
      const claim = await ledger.claim(passes.map(pass => ({
        paymentHash: pass!.paymentHash, provider: pass!.paymentProvider!, amountMsats: pass!.amountMsats!,
        ...(pass!.swarmReferral ? { referralOwner: pass!.swarmReferral.owner } : {}),
      })), invoice, parsed.data.bolt11_invoice, royaltyOwner ? {
        owner: royaltyOwner, paymentHashes: parsed.data.royalty_payment_hashes!,
      } : undefined);
      const settled = claim.paymentStatus === "settled";
      const event = { event: "yield_withdrawal_" + claim.paymentStatus, claim_id: claim.claimId,
        amount_msats: claim.totalMsats.toString(), receipt_count: claim.receiptCount };
      try { (options.logSettlement ?? (value => logger.info(value, "Mainnet yield withdrawal state")))(event); }
      catch { /* A logging failure cannot undo a committed claim. */ }
      res.status(settled ? 200 : 202).json({
        status: settled ? "SETTLED" : "PENDING", payment_sent: settled ? true : null,
        claim_id: claim.claimId, claimed_msats: claim.totalMsats.toString(),
        claimed_sats: Number(claim.totalMsats) / 1000, receipts_claimed: claim.receiptCount,
        remaining_balance_msats: settled ? "0" : claim.totalMsats.toString(),
        ...(claim.txid ? { coinos_txid: claim.txid } : {}),
        ...(claim.preimage ? { preimage: claim.preimage } : {}),
        ...(!settled ? { reconciliation_required: true } : {}),
      });
      if (settled) scheduleYieldBroadcast(claim.totalMsats, options.broadcastYield);
    } catch (error) {
      if (error instanceof AgentYieldInvariantError) { res.status(500).json({ error: error.code }); return; }
      if (error instanceof YieldClaimError) { res.status(error.status).json({ error: error.code }); return; }
      // Avoid database error details containing receipt identifiers or the request body.
      req.log?.error({ event: "yield_claim_storage_unavailable" }, "Private yield claim failed");
      res.status(503).json({ error: "YIELD_LEDGER_UNAVAILABLE" });
    }
  });
  app.post("/api/claim-yield/reconcile", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const operator = options.operatorSecret ?? process.env.MACAROON_OPERATOR_SECRET;
    if (!operator) { res.status(503).json({ error: "RECONCILIATION_UNAVAILABLE" }); return; }
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(req.get("Authorization") ?? ""), digest(`Bearer ${operator}`))) {
      res.status(403).json({ error: "OPERATOR_AUTHORIZATION_REQUIRED" }); return;
    }
    const parsed = z.object({ claim_id: z.string().uuid() }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "INVALID_RECONCILIATION_PAYLOAD" }); return; }
    try {
      if (!ledger.reconcile) throw new Error("No reconciliation backend");
      const claim = await ledger.reconcile(parsed.data.claim_id);
      res.status(claim.paymentStatus === "pending" ? 202 : 200).json({
        claim_id: claim.claimId, status: claim.paymentStatus.toUpperCase(),
        payment_sent: claim.paymentStatus === "pending" ? null : claim.paymentStatus === "settled",
        reconciliation_required: claim.paymentStatus === "pending",
        ...(claim.txid ? { coinos_txid: claim.txid } : {}), ...(claim.preimage ? { preimage: claim.preimage } : {}),
      });
    } catch (error) {
      if (error instanceof AgentYieldInvariantError) { res.status(500).json({ error: error.code }); return; }
      if (error instanceof YieldClaimError) { res.status(error.status).json({ error: error.code }); return; }
      res.status(503).json({ error: "RECONCILIATION_UNAVAILABLE" });
    }
  });
}
