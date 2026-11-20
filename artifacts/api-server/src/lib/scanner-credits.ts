// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHmac } from "node:crypto";

export const SCANNER_RETAIL_SATS = 5_000;
export const SCANNER_CREDIT_SATS = 100_000;
export const SCANNER_CREDITS = 100;
export const SCANNER_CREDIT_SECONDS = 30 * 24 * 60 * 60;
export const SCANNER_CREDIT_DESCRIPTION = "Article 12 Developer SaaS: 100 prepaid scanner credits";

/** Issuer-only funding privilege; a holder's append-only HMAC cannot forge it. */
export function scannerCreditProof(secret: string, hash: string, provider: string, validUntil: number, dynamic?: { amountMsats: number; credits: number }): string {
  if (dynamic) return "v2-" + createHmac("sha256", secret)
    .update("bitcoin-stratigraphy/scanner-credits/v2\n")
    .update(JSON.stringify([hash, provider, validUntil, dynamic.amountMsats, dynamic.credits]))
    .digest("hex");
  return createHmac("sha256", secret)
    .update("bitcoin-stratigraphy/scanner-credits/v1\n")
    .update(JSON.stringify([hash, provider, validUntil, SCANNER_CREDIT_SATS, SCANNER_CREDITS]))
    .digest("hex");
}
export function scannerDescription(credits: number): string {
  return credits === 1000 ? "Article 12 Heavy Swarm: 1000 prepaid scanner credits" : SCANNER_CREDIT_DESCRIPTION;
}
