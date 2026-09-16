export type PricingTier = "1-day" | "30-day";

export const STATIC_TIER_PRICING = {
  "1-day": { baseSats: 5, maxSats: 15 },
  "30-day": { baseSats: 100, maxSats: 250 },
} as const;

export type PricingQuote = {
  tier: PricingTier;
  priceSats: number;
  basePriceSats: number;
  maxPriceSats: number;
  multiplier: number;
  difficultyEpochProgress: number;
  requestVelocityRpm: number;
};

export type PricingEngine = {
  recordRequest(atMs?: number): void;
  requestVelocity(atMs?: number): number;
  quote(
    tier: PricingTier,
    difficultyEpochProgress: number,
    atMs?: number,
  ): PricingQuote;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function calculateTierCost(
  tier: PricingTier,
  difficultyEpochProgress?: number,
  requestVelocityRpm?: number,
): PricingQuote {
  const definition = STATIC_TIER_PRICING[tier];
  const progress =
    difficultyEpochProgress === undefined
      ? 0
      : clamp(
          Number.isFinite(difficultyEpochProgress)
            ? difficultyEpochProgress
            : 0,
          0,
          100,
        );
  const velocity =
    requestVelocityRpm === undefined
      ? 0
      : Math.max(
          0,
          Number.isFinite(requestVelocityRpm) ? requestVelocityRpm : 0,
        );
  const epochPressure = clamp((progress - 75) / 25, 0, 1);
  const velocityPressure = clamp((velocity - 120) / 480, 0, 1);
  const scarcityPressure = Math.max(epochPressure, velocityPressure);
  const unrounded =
    definition.baseSats +
    (definition.maxSats - definition.baseSats) * scarcityPressure;
  const priceSats = clamp(
    Math.round(unrounded),
    definition.baseSats,
    definition.maxSats,
  );

  return {
    tier,
    priceSats,
    basePriceSats: definition.baseSats,
    maxPriceSats: definition.maxSats,
    multiplier: Number((priceSats / definition.baseSats).toFixed(4)),
    difficultyEpochProgress: progress,
    requestVelocityRpm: velocity,
  };
}

export function createPricingEngine(input?: {
  now?: () => number;
  windowMs?: number;
}): PricingEngine {
  const now = input?.now ?? Date.now;
  const windowMs = input?.windowMs ?? 60_000;
  const requests: number[] = [];

  const prune = (atMs: number) => {
    const cutoff = atMs - windowMs;
    let expired = 0;
    while (expired < requests.length && requests[expired] <= cutoff) {
      expired += 1;
    }
    if (expired > 0) requests.splice(0, expired);
  };

  const requestVelocity = (atMs = now()) => {
    prune(atMs);
    return Number((requests.length * (60_000 / windowMs)).toFixed(2));
  };

  return {
    recordRequest(atMs = now()) {
      prune(atMs);
      requests.push(atMs);
    },
    requestVelocity,
    quote(tier, difficultyEpochProgress, atMs = now()) {
      return calculateTierCost(
        tier,
        difficultyEpochProgress,
        requestVelocity(atMs),
      );
    },
  };
}