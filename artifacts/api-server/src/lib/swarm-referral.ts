import { createHmac, timingSafeEqual } from "node:crypto";

const pubkey = /^[0-9a-f]{64}$/;
function sign(secret: string, domain: string, values: unknown[]): string {
  return createHmac("sha256", secret).update(`bitcoin-stratigraphy/swarm-referral/${domain}/v1\n` +
    JSON.stringify(values)).digest("hex");
}
function matches(actual: string, expected: string): boolean {
  return /^[0-9a-f]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
export function createSwarmReferralKey(owner: string, secret: string, expiresAt: number): string {
  if (!pubkey.test(owner) || !Number.isSafeInteger(expiresAt)) throw new RangeError("Invalid referral owner");
  return `sr1.${owner}.${expiresAt}.${sign(secret, "key", [owner, expiresAt])}`;
}
export function verifySwarmReferralKey(value: string | undefined, secret: string, now: number): string | null {
  if (!value || value.length > 256) return null;
  const parts = /^sr1\.([0-9a-f]{64})\.([1-9]\d{0,15})\.([0-9a-f]{64})$/.exec(value);
  if (!parts) return null;
  const expires = Number(parts[2]);
  return Number.isSafeInteger(expires) && expires * 1000 > now &&
    matches(parts[3]!, sign(secret, "key", [parts[1], expires])) ? parts[1]! : null;
}
export type SwarmReferral = { owner: string; quotedAmountMsats: number };
export function referralInvoiceProof(secret: string, paymentHash: string, amount: number,
  base: number, referral: SwarmReferral): string {
  return sign(secret, "invoice", [paymentHash, amount, base, referral.owner, referral.quotedAmountMsats]);
}
export function parseReferralInvoice(value: string, secret: string, hash: string,
  amount: number | undefined, base: number | undefined): SwarmReferral | null {
  const parts = /^([0-9a-f]{64}):([1-9]\d*):([0-9a-f]{64})$/.exec(value);
  if (!parts || amount === undefined || base === undefined) return null;
  const referral = { owner: parts[1]!, quotedAmountMsats: Number(parts[2]) };
  if (!Number.isSafeInteger(referral.quotedAmountMsats) || referral.quotedAmountMsats < base ||
      !Number.isSafeInteger(amount) || amount <= 0 ||
      BigInt(amount) !== BigInt(referral.quotedAmountMsats) * 95n / 100n ||
      !matches(parts[3]!, referralInvoiceProof(secret, hash, amount, base, referral))) return null;
  return referral;
}
