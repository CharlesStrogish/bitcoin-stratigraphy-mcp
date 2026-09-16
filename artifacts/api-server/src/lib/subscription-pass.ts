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

export type VerifiedSubscriptionMacaroon = {
  paymentHash: string;
  tier: SubscriptionTier;
  validUntil: number;
  allowedPaths: string[];
  maxRequests?: number;
  requestLimits: Array<{ tokenId: string; maxRequests: number }>;
  tokenId: string;
  amountMsats?: number;
};

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signatureFor(secret: string, identifier: string, caveats: string[]) {
  let signature = hmac(secret, identifier);
  for (const caveat of caveats) signature = hmac(signature, caveat);
  return signature;
}

function decodeMacaroon(encoded: string): SerializedMacaroon | null {
  try {
    const token = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SerializedMacaroon>;
    if (
      token.identifier !== "bitcoin-stratigraphy-subscription-v1" ||
      !Array.isArray(token.caveats) ||
      !token.caveats.every((caveat) => typeof caveat === "string") ||
      typeof token.signature !== "string" ||
      !/^[0-9a-f]{64}$/.test(token.signature)
    ) {
      return null;
    }
    return token as SerializedMacaroon;
  } catch {
    return null;
  }
}

export function getMacaroonSignatureId(encoded: string): string | null {
  return decodeMacaroon(encoded)?.signature ?? null;
}

export function attenuateSubscriptionMacaroon(
  encoded: string,
  newCaveats: string[],
): string | null {
  const token = decodeMacaroon(encoded);
  if (!token || newCaveats.length === 0) return null;
  let signature: Buffer<ArrayBufferLike> = Buffer.from(token.signature, "hex");
  for (const caveat of newCaveats) {
    if (
      !/^allowed_path=\/[^\s]*$/.test(caveat) &&
      !/^max_requests=[1-9]\d*$/.test(caveat)
    ) {
      return null;
    }
    signature = hmac(signature, caveat);
  }
  return Buffer.from(
    JSON.stringify({
      identifier: token.identifier,
      caveats: [...token.caveats, ...newCaveats],
      signature: signature.toString("hex"),
    } satisfies SerializedMacaroon),
  ).toString("base64url");
}

export function createSubscriptionMacaroon(input: {
  secret: string;
  paymentHash: string;
  tier: SubscriptionTier;
  validUntil: number;
  amountMsats?: number;
}): string {
  const identifier = "bitcoin-stratigraphy-subscription-v1";
  const caveats = [
    `payment_hash=${input.paymentHash}`,
    `tier=${input.tier}`,
    `valid_until=${input.validUntil}`,
    ...(input.amountMsats === undefined
      ? []
      : [`amount_msats=${input.amountMsats}`]),
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
  | VerifiedSubscriptionMacaroon
  | null {
  try {
    const token = decodeMacaroon(encoded);
    if (!token) return null;
    const supplied = Buffer.from(token.signature, "hex");
    let runningSignature: Buffer<ArrayBufferLike> = hmac(
      secret,
      token.identifier,
    );
    const rootValues = new Map<string, string>();
    const allowedPaths: string[] = [];
    const requestLimits: number[] = [];
    const meteredScopes: Array<{ tokenId: string; maxRequests: number }> = [];
    for (const caveat of token.caveats) {
      runningSignature = hmac(runningSignature, caveat);
      const separator = caveat.indexOf("=");
      if (separator <= 0) return null;
      const key = caveat.slice(0, separator);
      const value = caveat.slice(separator + 1);
      if (key === "allowed_path") {
        if (!/^\/[^\s]*$/.test(value)) return null;
        allowedPaths.push(value);
      } else if (key === "max_requests") {
        const limit = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(limit)) return null;
        requestLimits.push(limit);
        meteredScopes.push({
          tokenId: runningSignature.toString("hex"),
          maxRequests: limit,
        });
      } else {
        if (
          !["payment_hash", "tier", "valid_until", "amount_msats"].includes(key) ||
          rootValues.has(key)
        ) {
          return null;
        }
        rootValues.set(key, value);
      }
    }
    if (!timingSafeEqual(supplied, runningSignature)) return null;
    if (
      (rootValues.size !== 3 && rootValues.size !== 4) ||
      !rootValues.has("payment_hash") ||
      !rootValues.has("tier") ||
      !rootValues.has("valid_until")
    ) {
      return null;
    }
    const paymentHash = rootValues.get("payment_hash")!;
    const tier = rootValues.get("tier") as SubscriptionTier;
    const validUntil = Number(rootValues.get("valid_until"));
    const amountMsatsValue = rootValues.get("amount_msats");
    const amountMsats =
      amountMsatsValue === undefined ? undefined : Number(amountMsatsValue);
    if (
      !/^[0-9a-f]{64}$/.test(paymentHash) ||
      !(tier in SUBSCRIPTION_TIERS) ||
      !Number.isSafeInteger(validUntil) ||
      validUntil <= nowSeconds
      || (amountMsatsValue !== undefined &&
        (!/^[1-9]\d*$/.test(amountMsatsValue) ||
          !Number.isSafeInteger(amountMsats)))
    ) {
      return null;
    }
    return {
      paymentHash,
      tier,
      validUntil,
      allowedPaths,
      maxRequests:
        requestLimits.length > 0 ? Math.min(...requestLimits) : undefined,
      requestLimits: meteredScopes,
      tokenId: token.signature,
      amountMsats,
    };
  } catch {
    return null;
  }
}