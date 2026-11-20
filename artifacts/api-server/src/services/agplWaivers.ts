import { createHash, randomUUID, sign } from "node:crypto";
import { canonical, loadArticle12IssuerKey, issuerKeyId } from "../lib/article12-signature";
import { AS_IS_TERMS } from "../lib/as-is-terms";
import { btcSpotOracle, usdToSats, type SpotOracle } from "./btcSpotOracle";

export const WAIVER_DOMAIN = "bitcoin-stratigraphy:agpl-waiver:v1";
export const WAIVER_SCOPE = "AGPLV3_SECTION_13_COMMERCIAL_WAIVER_AS_IS_NO_SLA";
export const WAIVER_TERMS_SHA256 = createHash("sha256").update(AS_IS_TERMS, "utf8").digest("hex");
export const WAIVER_TIERS = Object.freeze({
  swarm_monthly: { usd: 2500, days: 30 },
  swarm_annual: { usd: 25000, days: 365 },
  global_monthly: { usd: 25000, days: 30 },
  global_annual: { usd: 250000, days: 365 },
});
export type WaiverQuote = {
  quote_id: string; tier: keyof typeof WAIVER_TIERS; licensee_name: string; licensee_identifier: string;
  usd_basis: number; quoted_sats: number; btc_spot_usd: number; settlement_address: string;
  min_confirmations: number; terms_sha256: string; created_at: string; expires_at: string;
};
export type Certificate = Record<string, unknown> & { waiver_id: string; txid: string; vout: number };
export interface WaiverStore {
  saveQuote(quote: WaiverQuote): Promise<void>;
  quote(id: string): Promise<WaiverQuote | null>;
  certificate(quoteId: string): Promise<Certificate | null>;
  issue(quote: WaiverQuote, certificate: Certificate, now: number): Promise<Certificate>;
}
export class WaiverError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type ChainSettlement = { confirmed: boolean; confirmations: number; blockTime: number;
  outputs: { address: string; sats: number; vout: number }[] };
/** Tip and transaction must come from the same provider; a negative result never fails over. */
export function createWaiverChainReader(request: typeof fetch = fetch) {
  return async (txid: string): Promise<ChainSettlement> => {
    for (const base of ["https://mempool.space/api", "https://blockstream.info/api"]) {
      try {
        const get = async (path: string) => {
          const response = await request(base + path, { signal: AbortSignal.timeout(5000), redirect: "error" });
          if (!response.ok) throw new Error("Chain provider unavailable");
          return response;
        };
        const tx = await (await get(`/tx/${txid}`)).json() as any;
        if (tx.txid !== txid || !tx.status || !Array.isArray(tx.vout)) throw new Error("Invalid chain response");
        if (tx.status.confirmed !== true) return { confirmed: false, confirmations: 0, blockTime: 0, outputs: [] };
        const tip = Number(await (await get("/blocks/tip/height")).text());
        const height = tx.status.block_height, time = tx.status.block_time;
        if (!Number.isSafeInteger(tip) || !Number.isSafeInteger(height) || height < 0 || tip < height ||
            !Number.isSafeInteger(time) || time <= 0) throw new Error("Invalid chain height/time");
        const outputs = tx.vout.map((output: any, vout: number) => {
          if (!Number.isSafeInteger(output.value) || output.value < 0) throw new Error("Invalid chain output");
          return { address: output.scriptpubkey_address ?? "", sats: output.value, vout };
        });
        return { confirmed: true, confirmations: tip - height + 1, blockTime: time * 1000, outputs };
      } catch { /* Fallback only for unavailable/malformed providers, never a negative payment. */ }
    }
    throw new WaiverError(503, "waiver_chain_verification_unavailable");
  };
}
export function createWaiverService(options: {
  store: WaiverStore; oracle?: SpotOracle; chain?: ReturnType<typeof createWaiverChainReader>;
  now?: () => number; env?: () => { WAIVER_BTC_ADDRESS?: string; WAIVER_MIN_CONFIRMATIONS?: string };
  signingKey?: typeof loadArticle12IssuerKey;
}) {
  const now = options.now ?? Date.now;
  return {
    async quote(input: any): Promise<WaiverQuote> {
      if (!input || Array.isArray(input) || input.terms_accepted !== true ||
           typeof input.tier !== "string" || !Object.hasOwn(WAIVER_TIERS, input.tier) ||
          Object.keys(input).some(key => !["tier","licensee_name","licensee_identifier","terms_accepted"].includes(key)) ||
          ![input.licensee_name, input.licensee_identifier].every(value => typeof value === "string" &&
            value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)))
        throw new WaiverError(400, "invalid_waiver_quote");
      const env = options.env?.() ?? process.env;
      const address = env.WAIVER_BTC_ADDRESS?.trim();
      if (!address) throw new WaiverError(503, "waiver_settlement_address_unconfigured");
      // Public address only; never parse or accept a wallet's signing material.
      if (!/^(?:bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address))
        throw new WaiverError(503, "waiver_settlement_address_unconfigured");
      const confirmations = Number(env.WAIVER_MIN_CONFIRMATIONS ?? 2);
      if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 1008)
        throw new WaiverError(503, "waiver_confirmation_policy_invalid");
      const tier = input.tier as keyof typeof WAIVER_TIERS;
      issuerKeyId((options.signingKey ?? loadArticle12IssuerKey)());
      const spot = await (options.oracle ?? btcSpotOracle).quote();
      const time = now();
      const quote: WaiverQuote = { quote_id: randomUUID(), tier,
        licensee_name: input.licensee_name.trim(), licensee_identifier: input.licensee_identifier.trim(),
        usd_basis: WAIVER_TIERS[tier].usd, quoted_sats: usdToSats(WAIVER_TIERS[tier].usd, spot.btcUsd),
        btc_spot_usd: spot.btcUsd, settlement_address: address, min_confirmations: confirmations,
        terms_sha256: WAIVER_TERMS_SHA256, created_at: new Date(time).toISOString(),
        expires_at: new Date(time + 30 * 60_000).toISOString() };
      await options.store.saveQuote(quote);
      return quote;
    },
    async claim(input: any): Promise<Certificate> {
      if (!input || typeof input.quote_id !== "string" || !/^[0-9a-f-]{36}$/.test(input.quote_id) ||
          typeof input.txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(input.txid) ||
          Object.keys(input).some(key => !["quote_id","txid"].includes(key))) throw new WaiverError(400, "invalid_waiver_claim");
      const txid = input.txid.toLowerCase();
      const old = await options.store.certificate(input.quote_id);
      if (old) {
        if (old.txid !== txid) throw new WaiverError(409, "waiver_quote_already_claimed");
        return old;
      }
      const quote = await options.store.quote(input.quote_id);
      if (!quote) throw new WaiverError(404, "waiver_quote_not_found");
      const settlement = await (options.chain ?? createWaiverChainReader())(txid);
      if (!settlement.confirmed || !Number.isSafeInteger(settlement.confirmations) ||
          settlement.confirmations < quote.min_confirmations) throw new WaiverError(409, "waiver_payment_unconfirmed");
      if (!Number.isSafeInteger(settlement.blockTime) || settlement.blockTime < Date.parse(quote.created_at) ||
          settlement.blockTime > now()) throw new WaiverError(409, "waiver_payment_predates_quote");
      if (settlement.blockTime >= Date.parse(quote.expires_at)) throw new WaiverError(410, "waiver_quote_expired");
      const outputs = settlement.outputs.filter(output => output.address === quote.settlement_address &&
        Number.isSafeInteger(output.sats) && output.sats >= quote.quoted_sats &&
        Number.isSafeInteger(output.vout) && output.vout >= 0);
      if (!outputs.length) throw new WaiverError(409, "waiver_payment_underpaid");
      const issued = now();
      const key = (options.signingKey ?? loadArticle12IssuerKey)();
      for (const output of outputs) {
      const payload = { waiver_id: randomUUID(), tier: quote.tier, licensee_name: quote.licensee_name,
        licensee_identifier: quote.licensee_identifier, txid, vout: output.vout, sats_paid: output.sats,
        usd_basis: quote.usd_basis, issued_at: new Date(issued).toISOString(),
        expires_at: new Date(issued + WAIVER_TIERS[quote.tier].days * 86400_000).toISOString(),
        terms_sha256: quote.terms_sha256, scope: WAIVER_SCOPE, issuer_key_id: issuerKeyId(key) };
      const certificate = { ...payload, signature: sign(null, Buffer.from(WAIVER_DOMAIN + canonical(payload)), key).toString("base64") };
      // Timely confirmed funds stay claimable while additional confirmations accrue.
      // Never extend the price lock to a transaction confirmed after its deadline.
      try { return await options.store.issue(quote, certificate, settlement.blockTime); }
      catch (error) {
        if (!(error instanceof WaiverError) || error.message !== "waiver_transaction_output_already_claimed") throw error;
      }
      }
      throw new WaiverError(409, "waiver_transaction_output_already_claimed");
    },
  };
}
