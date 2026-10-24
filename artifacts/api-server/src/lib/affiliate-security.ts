// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type { EnterpriseEconomics } from "./enterprise-economics";
import {
  createAffiliateProviderReader,
  providerOwnerKey,
  type ProviderReader,
} from "./affiliate-provider";

export const AFFILIATE_VERIFICATION_MS = 24 * 60 * 60 * 1_000;
export class AffiliateProofError extends Error {}

export async function verifyAffiliate(
  service: EnterpriseEconomics,
  agent: string,
  signer: string,
  proofId: string,
  read: ProviderReader = createAffiliateProviderReader(),
): Promise<Record<string, unknown>> {
  const owner = await providerOwnerKey(agent, read);
  if (owner.pubkey !== signer)
    throw new AffiliateProofError(
      "Signature does not match the provider-authorized address key",
    );
  return service.store.transaction("affiliate:" + agent, async (tx) => {
    if (await tx.isRevoked(agent))
      throw new AffiliateProofError("Agent is revoked");
    if (await tx.security("proof:" + proofId))
      throw new AffiliateProofError("Ownership proof already consumed");
    const verification = {
      agent_id: agent,
      pubkey: signer,
      verified_at: service.now(),
      expires_at: service.now() + AFFILIATE_VERIFICATION_MS,
      provider_record_url: owner.url,
      proof_id: proofId,
    };
    await tx.putSecurity("proof:" + proofId, {
      expires_at: service.now() + 120_000,
    });
    await tx.putSecurity("affiliate:" + agent, verification);
    return verification;
  });
}

/** Payability is a live ledger projection, never a durable bypass around verification or CRL.
 * Historic allocation amounts are immutable; verification never changes a signed invoice.
 */
export async function affiliateBalance(
  service: EnterpriseEconomics,
  agent: string,
): Promise<Record<string, unknown>> {
  return service.store.transaction("affiliate:" + agent, async (tx) => {
    const profile = await tx.security("affiliate:" + agent);
    const revoked = await tx.isRevoked(agent);
    const verified =
      !revoked &&
      typeof profile?.expires_at === "number" &&
      profile.expires_at > service.now();
    let pending = 0n,
      payable = 0n;
    const allocations = (await tx.rewardInvoices(agent)).map((invoice) => {
      const direct = invoice.payout === agent;
      const amount = BigInt(
        direct
          ? (invoice.direct_kickback_msats ?? invoice.kickback_msats)
          : (invoice.parent_kickback_msats ?? "0"),
      );
      const state = verified && invoice.settled_at ? "payable" : "pending";
      if (state === "payable") payable += amount;
      else pending += amount;
      return {
        payment_hash: invoice.hash,
        role: direct ? "direct" : "parent",
        amount_msats: amount.toString(),
        state,
        invoice_settled: Boolean(invoice.settled_at),
      };
    });
    return {
      agent_id: agent,
      verified,
      revoked,
      pending_msats: pending.toString(),
      payable_msats: payable.toString(),
      payout_mode: "ledger_only_no_automatic_disbursement",
      allocations,
    };
  });
}
