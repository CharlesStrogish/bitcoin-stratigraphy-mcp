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
import { parseDelegationCaveat } from "./delegation-caveats";
import { equivalentToolNames } from "./mcp-pricing";

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
  /** Effective authorization deadline including descendant time caveats. */
  expiresAt?: number;
  /** Earliest delegated `time <` or `time_before` deadline in epoch milliseconds. */
  timeCaveatDeadline?: number;
  /** Legacy alias-equivalent `allowed_tools` sets; each must authorize the tool. */
  allowedToolSets: string[][];
  /** Exact `rpc` tool sets; each must name the executing tool verbatim. */
  rpcToolSets: string[][];
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
    // Holders may append only exactly formatted delegation caveats.
    if (!parseDelegationCaveat(caveat)) return null;
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

const ROOT_CAVEAT_KEYS = new Set([
  "payment_hash",
  "tier",
  "valid_until",
  "amount_msats",
  "agent_pubkey",
  "agent_tier",
  "payment_asset",
  "payment_provider",
]);

/**
 * Authenticates the HMAC chain and parses every caveat strictly, without
 * applying any clock. Callers must enforce `validUntil` and
 * `timeCaveatDeadline`; prefer verifySubscriptionMacaroon unless the expiry
 * response needs to distinguish delegated deadlines from root expiry.
 */
export function inspectSubscriptionMacaroon(
  encoded: string,
  secret: string,
  presentingAgent?: Pick<AgentIdentity, "pubkey" | "tier"> | null,
): VerifiedSubscriptionMacaroon | null {
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
    const rpcToolSets: string[][] = [];
    let maxTarget: number | undefined;
    let timeCaveatDeadline: number | undefined;
    const requestLimits: number[] = [];
    const meteredScopes: Array<{ tokenId: string; maxRequests: number }> = [];
    for (const caveat of token.caveats) {
      runningSignature = hmac(runningSignature, caveat);
      const delegation = parseDelegationCaveat(caveat);
      if (delegation?.type === "allowed_path") {
        allowedPaths.push(delegation.path);
      } else if (delegation?.type === "max_requests") {
        requestLimits.push(delegation.limit);
        meteredScopes.push({
          tokenId: runningSignature.toString("hex"),
          maxRequests: delegation.limit,
        });
      } else if (delegation?.type === "time") {
        timeCaveatDeadline = Math.min(
          timeCaveatDeadline ?? delegation.deadline,
          delegation.deadline,
        );
      } else if (delegation?.type === "max_target") {
        maxTarget = Math.min(maxTarget ?? delegation.height, delegation.height);
      } else if (delegation?.type === "allowed_tools") {
        allowedToolSets.push(delegation.tools);
      } else if (delegation?.type === "rpc") {
        rpcToolSets.push(delegation.tools);
      } else {
        // Anything else must be a single issuer caveat; malformed or unknown
        // delegation caveats invalidate the whole credential.
        const separator = caveat.indexOf("=");
        const key = caveat.slice(0, Math.max(separator, 0));
        if (
          separator <= 0 ||
          !ROOT_CAVEAT_KEYS.has(key) ||
          rootValues.has(key)
        ) {
          return null;
        }
        rootValues.set(key, caveat.slice(separator + 1));
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
      (amountMsatsValue !== undefined &&
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
        3 +
          (amountMsatsValue === undefined ? 0 : 1) +
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
      expiresAt: Math.min(validUntil * 1_000, timeCaveatDeadline ?? Infinity),
      timeCaveatDeadline,
      allowedPaths,
      allowedToolSets,
      rpcToolSets,
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

/** Authentic and unexpired under both the root validity and every time caveat. */
export function verifySubscriptionMacaroon(
  encoded: string,
  secret: string,
  nowSeconds: number,
  presentingAgent?: Pick<AgentIdentity, "pubkey" | "tier"> | null,
): VerifiedSubscriptionMacaroon | null {
  const pass = inspectSubscriptionMacaroon(encoded, secret, presentingAgent);
  return pass &&
    pass.validUntil > nowSeconds &&
    !(
      pass.timeCaveatDeadline !== undefined &&
      nowSeconds * 1_000 >= pass.timeCaveatDeadline
    )
    ? pass
    : null;
}

/** Restrictions that only an MCP tool route can evaluate. */
export function hasMcpScopedCaveats(
  pass: VerifiedSubscriptionMacaroon,
): boolean {
  return (
    pass.rpcToolSets.length > 0 ||
    pass.allowedToolSets.length > 0 ||
    pass.maxTarget !== undefined
  );
}

/**
 * Every `rpc` caveat must name the tool exactly; every legacy `allowed_tools`
 * caveat must name it or one of its legacy aliases.
 */
export function macaroonAuthorizesTool(
  pass: VerifiedSubscriptionMacaroon,
  tool: string,
): boolean {
  const equivalent = equivalentToolNames(tool);
  return (
    pass.rpcToolSets.every((tools) => tools.includes(tool)) &&
    pass.allowedToolSets.every((tools) =>
      equivalent.some((name) => tools.includes(name)),
    )
  );
}

export type DelegationCaveatRejection = {
  status: 401 | 403;
  error: string;
};

/**
 * Enforces the first-party caveats that need no request arguments: the
 * earliest delegated deadline (millisecond precision, exclusive) and tool
 * scope. Pass the exact MCP tool being executed; routes that execute no MCP
 * tool omit it and reject tool or target scoped credentials outright.
 * `max_target` needs the request arguments, so MCP routes enforce it before
 * invoking a payment gate.
 */
export function delegationCaveatRejection(
  pass: VerifiedSubscriptionMacaroon,
  request: { nowMs: number; tool?: string },
): DelegationCaveatRejection | null {
  if (
    pass.timeCaveatDeadline !== undefined &&
    request.nowMs >= pass.timeCaveatDeadline
  ) {
    return { status: 401, error: "Macaroon time caveat has expired" };
  }
  if (request.tool === undefined) {
    return hasMcpScopedCaveats(pass)
      ? {
          status: 403,
          error: "Macaroon tool or target caveat forbids this route",
        }
      : null;
  }
  return macaroonAuthorizesTool(pass, request.tool)
    ? null
    : {
        status: 403,
        error: `Macaroon tool caveat does not authorize ${request.tool}`,
      };
}
