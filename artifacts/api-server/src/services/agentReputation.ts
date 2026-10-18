import { createHash } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools";

export const AGENT_TIERS = ["STANDARD", "VIP", "SWARM"] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];

export type AgentIdentity = {
  pubkey: string;
  tier: AgentTier;
  discountPercent: number;
  rateLimitMultiplier: number;
};

export type AgentPricing = AgentIdentity & {
  originalPriceSats: number;
  priceSats: number;
  discountSats: number;
};

export const AGENT_TIER_POLICIES: Record<
  AgentTier,
  { discountPercent: number; rateLimitMultiplier: number }
> = {
  STANDARD: { discountPercent: 0, rateLimitMultiplier: 1 },
  VIP: { discountPercent: 15, rateLimitMultiplier: 2 },
  SWARM: { discountPercent: 30, rateLimitMultiplier: 5 },
};

export type AgentReputationService = {
  identityForPubkey(pubkey: string): AgentIdentity;
  verifyNip98Authorization(input: {
    authorization: string;
    method: string;
    url: string;
    nowSeconds?: number;
    payload?: Uint8Array | string;
  }): AgentIdentity | null;
  applyPricing(priceSats: number, identity?: AgentIdentity): AgentPricing;
};

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
const MAX_AUTHORIZATION_LENGTH = 16_384;

function normalizeTierRegistry(
  tiers: Record<string, AgentTier>,
): Map<string, AgentTier> {
  const registry = new Map<string, AgentTier>();
  for (const [rawPubkey, tier] of Object.entries(tiers)) {
    const pubkey = rawPubkey.toLowerCase();
    if (!PUBKEY_PATTERN.test(pubkey) || !AGENT_TIERS.includes(tier)) {
      throw new Error("Agent reputation registry contains an invalid entry");
    }
    registry.set(pubkey, tier);
  }
  return registry;
}

function registryFromEnvironment(): Record<string, AgentTier> {
  const configured = process.env.AGENT_REPUTATION_TIERS;
  if (!configured) return {};
  try {
    const parsed = JSON.parse(configured) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("registry must be an object");
    }
    return parsed as Record<string, AgentTier>;
  } catch {
    throw new Error(
      "AGENT_REPUTATION_TIERS must be a JSON object mapping pubkeys to tiers",
    );
  }
}

function decodeNip98Event(value: string): Event | null {
  const match = /^Nostr ([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!match || value.length > MAX_AUTHORIZATION_LENGTH) return null;
  try {
    const bytes = Buffer.from(match[1], "base64");
    if (
      bytes.length === 0 ||
      bytes.toString("base64").replace(/=+$/, "") !==
        match[1].replace(/=+$/, "")
    ) {
      return null;
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<Event>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.tags) ||
      !parsed.tags.every(
        (tag) =>
          Array.isArray(tag) && tag.every((value) => typeof value === "string"),
      )
    ) {
      return null;
    }
    return parsed as Event;
  } catch {
    return null;
  }
}

function inspectTag(
  event: Event,
  name: string,
):
  | { state: "absent" }
  | { state: "valid"; value: string }
  | { state: "invalid" } {
  const tags = event.tags.filter((tag) => tag[0] === name);
  if (tags.length === 0) return { state: "absent" };
  return tags.length === 1 &&
    tags[0].length === 2 &&
    typeof tags[0][1] === "string"
    ? { state: "valid", value: tags[0][1] }
    : { state: "invalid" };
}

/**
 * Verifies a NIP-98 HTTP Auth event and returns its signer's lowercase pubkey.
 * The kind 27235 event must have empty content, be at most maxAgeSeconds old
 * and never future-dated, and carry exactly one `u` tag equal to the absolute
 * request URL and one `method` tag equal to the HTTP method. With a payload,
 * exactly one `payload` tag must equal its SHA-256 hex; without one, the event
 * must carry no payload tag. Any other event, or a bad Schnorr signature,
 * returns null.
 */
export function verifyNip98Signer(input: {
  authorization: string;
  method: string;
  url: string;
  nowSeconds: number;
  payload?: Uint8Array | string;
  maxAgeSeconds?: number;
}): string | null {
  const { nowSeconds, payload } = input;
  const maxAgeSeconds = input.maxAgeSeconds ?? 60;
  const event = decodeNip98Event(input.authorization);
  if (
    !event ||
    event.kind !== 27_235 ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at > nowSeconds ||
    nowSeconds - event.created_at > maxAgeSeconds ||
    event.content !== ""
  ) {
    return null;
  }
  const eventUrl = inspectTag(event, "u");
  const eventMethod = inspectTag(event, "method");
  const eventPayload = inspectTag(event, "payload");
  if (
    eventUrl.state !== "valid" ||
    eventMethod.state !== "valid" ||
    eventUrl.value !== input.url ||
    eventMethod.value !== input.method
  ) {
    return null;
  }
  if (payload !== undefined) {
    const expectedPayload = createHash("sha256").update(payload).digest("hex");
    if (
      eventPayload.state !== "valid" ||
      eventPayload.value !== expectedPayload
    ) {
      return null;
    }
  } else if (eventPayload.state !== "absent") {
    return null;
  }
  try {
    if (!verifyEvent(event)) return null;
    const pubkey = event.pubkey.toLowerCase();
    return PUBKEY_PATTERN.test(pubkey) ? pubkey : null;
  } catch {
    return null;
  }
}

export function createAgentReputationService(input?: {
  tiers?: Record<string, AgentTier>;
  now?: () => number;
  maxAgeSeconds?: number;
}): AgentReputationService {
  const registry = normalizeTierRegistry(
    input?.tiers ?? registryFromEnvironment(),
  );
  const now = input?.now ?? Date.now;
  const maxAgeSeconds = input?.maxAgeSeconds ?? 60;

  const identityForPubkey = (rawPubkey: string): AgentIdentity => {
    const pubkey = rawPubkey.toLowerCase();
    if (!PUBKEY_PATTERN.test(pubkey)) {
      throw new Error(
        "Agent pubkey must be 64 lowercase hexadecimal characters",
      );
    }
    const tier = registry.get(pubkey) ?? "STANDARD";
    return { pubkey, tier, ...AGENT_TIER_POLICIES[tier] };
  };

  return {
    identityForPubkey,
    verifyNip98Authorization({
      authorization,
      method,
      url,
      nowSeconds = Math.floor(now() / 1_000),
      payload,
    }) {
      const pubkey = verifyNip98Signer({
        authorization,
        method,
        url,
        nowSeconds,
        payload,
        maxAgeSeconds,
      });
      return pubkey === null ? null : identityForPubkey(pubkey);
    },
    applyPricing(originalPriceSats, identity) {
      if (!Number.isSafeInteger(originalPriceSats) || originalPriceSats < 1) {
        throw new Error("Price must be a positive integer number of satoshis");
      }
      const resolved =
        identity ??
        ({
          pubkey: "",
          tier: "STANDARD",
          ...AGENT_TIER_POLICIES.STANDARD,
        } satisfies AgentIdentity);
      const priceSats = Math.max(
        1,
        Math.round(originalPriceSats * (1 - resolved.discountPercent / 100)),
      );
      return {
        ...resolved,
        originalPriceSats,
        priceSats,
        discountSats: originalPriceSats - priceSats,
      };
    },
  };
}
