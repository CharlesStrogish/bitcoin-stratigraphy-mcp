import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentIdentity, AgentTier } from "../services/agentReputation";
import {
  constructAgentIdentityCaveats,
  constructPaymentAssetCaveat,
  constructPaymentProviderCaveat,
  parseAgentIdentityCaveats,
  parsePaymentAssetCaveat,
  parsePaymentProviderCaveat,
  presentingAgentMatchesCaveats,
} from "../services/l402Caveats";
import type { SettlementAsset } from "../services/settlement/types";

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
  allowedToolSets: string[][];
  maxTarget?: number;
  maxRequests?: number;
  requestLimits: Array<{ tokenId: string; maxRequests: number }>;
  tokenId: string;
  amountMsats?: number;
  agentPubkey?: string;
  agentTier?: AgentTier;
  paymentAsset: SettlementAsset;
  paymentProvider?: string;
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
      !/^max_requests=[1-9]\d*$/.test(caveat) &&
      !/^time_before=(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.test(caveat) &&
      !/^max_target=(?:0|[1-9]\d*)$/.test(caveat) &&
      !/^allowed_tools=[a-z][a-z0-9]*\.[a-z][a-z0-9_]*(?:,[a-z][a-z0-9]*\.[a-z][a-z0-9_]*)*$/.test(caveat)
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
  agentIdentity?: Pick<AgentIdentity, "pubkey" | "tier">;
  paymentAsset?: SettlementAsset;
  paymentProvider?: string;
}): string {
  if (input.paymentAsset && !input.paymentProvider) {
    throw new Error("Asset-bound macaroons require a settlement provider");
  }
  const identifier = "bitcoin-stratigraphy-subscription-v1";
  const caveats = [
    `payment_hash=${input.paymentHash}`,
    `tier=${input.tier}`,
    `valid_until=${input.validUntil}`,
    ...(input.amountMsats === undefined
      ? []
      : [`amount_msats=${input.amountMsats}`]),
    ...constructPaymentAssetCaveat(input.paymentAsset),
    ...constructPaymentProviderCaveat(input.paymentProvider),
    ...constructAgentIdentityCaveats(input.agentIdentity),
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
  presentingAgent?: Pick<AgentIdentity, "pubkey" | "tier"> | null,
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
    const allowedToolSets: string[][] = [];
    let maxTarget: number | undefined;
    let timeBefore: number | undefined;
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
      } else if (key === "time_before") {
        if (!/^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.test(value)) return null;
        const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
        if (!Number.isFinite(parsed) ||
          new Date(parsed).toISOString() !== (value.length === 10 ? `${value}T00:00:00.000Z` : value)) return null;
        // A date-only caveat includes that calendar date; timestamps use exclusive bounds.
        const expiry = parsed + (value.length === 10 ? 86_400_000 : 0);
        timeBefore = Math.min(timeBefore ?? expiry, expiry);
      } else if (key === "max_target") {
        const bound = Number(value);
        if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(bound)) return null;
        maxTarget = Math.min(maxTarget ?? bound, bound);
      } else if (key === "allowed_tools") {
        if (!/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*(?:,[a-z][a-z0-9]*\.[a-z][a-z0-9_]*)*$/.test(value)) return null;
        allowedToolSets.push(value.split(","));
      } else {
        if (
          ![
            "payment_hash",
            "tier",
            "valid_until",
            "amount_msats",
            "agent_pubkey",
            "agent_tier",
            "payment_asset",
            "payment_provider",
          ].includes(key) ||
          rootValues.has(key)
        ) {
          return null;
        }
        rootValues.set(key, value);
      }
    }
    if (!timingSafeEqual(supplied, runningSignature)) return null;
    if (
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
    const agentCaveats = parseAgentIdentityCaveats(rootValues);
    const paymentAssetCaveat = parsePaymentAssetCaveat(rootValues);
    const paymentProviderCaveat = parsePaymentProviderCaveat(rootValues);
    if (
      !/^[0-9a-f]{64}$/.test(paymentHash) ||
      !(tier in SUBSCRIPTION_TIERS) ||
      !Number.isSafeInteger(validUntil) ||
      validUntil <= nowSeconds
      || (timeBefore !== undefined && nowSeconds * 1_000 >= timeBefore)
      || (amountMsatsValue !== undefined &&
        (!/^[1-9]\d*$/.test(amountMsatsValue) ||
          !Number.isSafeInteger(amountMsats))) ||
      agentCaveats === null ||
      paymentAssetCaveat === null ||
      paymentProviderCaveat === null ||
      (presentingAgent !== undefined &&
        !presentingAgentMatchesCaveats(
          agentCaveats,
          presentingAgent ?? undefined,
        )) ||
      rootValues.size !==
        3 + (amountMsatsValue === undefined ? 0 : 1) +
          (paymentAssetCaveat === undefined ? 0 : 1) +
          (paymentProviderCaveat === undefined ? 0 : 1) +
          (agentCaveats === undefined ? 0 : 2)
    ) {
      return null;
    }
    return {
      paymentHash,
      tier,
      validUntil,
      allowedPaths,
      allowedToolSets,
      maxTarget,
      maxRequests:
        requestLimits.length > 0 ? Math.min(...requestLimits) : undefined,
      requestLimits: meteredScopes,
      tokenId: token.signature,
      amountMsats,
      agentPubkey: agentCaveats?.agentPubkey,
      agentTier: agentCaveats?.agentTier,
      paymentAsset: paymentAssetCaveat ?? "btc-lightning",
      paymentProvider: paymentProviderCaveat,
    };
  } catch {
    return null;
  }
}