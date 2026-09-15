import { createHmac, timingSafeEqual } from "node:crypto";

export type SubscriptionTier = "1-day" | "30-day";

export const SUBSCRIPTION_TIERS = {
  "1-day": {
    amountMsats: 5_000,
    durationSeconds: 24 * 60 * 60,
    description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
  },
  "30-day": {
    amountMsats: 100_000,
    durationSeconds: 30 * 24 * 60 * 60,
    description: "Bitcoin Stratigraphy 30-Day Pass",
  },
} as const;

type SerializedMacaroon = {
  identifier: "bitcoin-stratigraphy-subscription-v1";
  caveats: string[];
  signature: string;
};

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signatureFor(secret: string, identifier: string, caveats: string[]) {
  let signature = hmac(secret, identifier);
  for (const caveat of caveats) signature = hmac(signature, caveat);
  return signature;
}

export function createSubscriptionMacaroon(input: {
  secret: string;
  paymentHash: string;
  tier: SubscriptionTier;
  validUntil: number;
}): string {
  const identifier = "bitcoin-stratigraphy-subscription-v1";
  const caveats = [
    `payment_hash=${input.paymentHash}`,
    `tier=${input.tier}`,
    `valid_until=${input.validUntil}`,
  ];
  const token: SerializedMacaroon = {
    identifier,
    caveats,
    signature: signatureFor(input.secret, identifier, caveats).toString("hex"),
  };
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}

export function verifySubscriptionMacaroon(
  encoded: string,
  secret: string,
  nowSeconds: number,
):
  | {
      paymentHash: string;
      tier: SubscriptionTier;
      validUntil: number;
    }
  | null {
  try {
    const token = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SerializedMacaroon>;
    if (
      token.identifier !== "bitcoin-stratigraphy-subscription-v1" ||
      !Array.isArray(token.caveats) ||
      typeof token.signature !== "string" ||
      !/^[0-9a-f]{64}$/.test(token.signature)
    ) {
      return null;
    }
    const supplied = Buffer.from(token.signature, "hex");
    const expected = signatureFor(secret, token.identifier, token.caveats);
    if (!timingSafeEqual(supplied, expected)) return null;

    const values = new Map<string, string>();
    for (const caveat of token.caveats) {
      const separator = caveat.indexOf("=");
      if (separator <= 0) return null;
      const key = caveat.slice(0, separator);
      if (values.has(key)) return null;
      values.set(key, caveat.slice(separator + 1));
    }
    if (
      values.size !== 3 ||
      !values.has("payment_hash") ||
      !values.has("tier") ||
      !values.has("valid_until")
    ) {
      return null;
    }
    const paymentHash = values.get("payment_hash")!;
    const tier = values.get("tier") as SubscriptionTier;
    const validUntil = Number(values.get("valid_until"));
    if (
      !/^[0-9a-f]{64}$/.test(paymentHash) ||
      !(tier in SUBSCRIPTION_TIERS) ||
      !Number.isSafeInteger(validUntil) ||
      validUntil <= nowSeconds
    ) {
      return null;
    }
    return { paymentHash, tier, validUntil };
  } catch {
    return null;
  }
}