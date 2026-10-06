export type PricingTier = "1-day" | "30-day";
export type JobKind = "stratigraphy" | "zk-proof";

export const BASE_JOB_FEES = {
  stratigraphy: 5,
  "zk-proof": 21,
} as const;

export type SystemLoad = {
  queueLength: number;
  queueCapacity: number;
  cpuUtilization: number;
};

export type JobPricingQuote = {
  jobKind: JobKind;
  priceSats: number;
  basePriceSats: number;
  multiplier: number;
  queueSaturation: number;
  cpuUtilization: number;
  load: number;
};

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
  jobQuote?(jobKind: JobKind, load?: SystemLoad): JobPricingQuote;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function calculateJobPrice(
  jobKind: JobKind,
  load: SystemLoad,
  maxLoadMultiplier = 3,
): JobPricingQuote {
  const basePriceSats = BASE_JOB_FEES[jobKind];
  const queueLength = Math.max(0, Math.trunc(load.queueLength));
  const queueCapacity = Math.max(1, Math.trunc(load.queueCapacity));
  const queueSaturation = clamp(queueLength / queueCapacity, 0, 1);
  const cpuUtilization = clamp(
    Number.isFinite(load.cpuUtilization) ? load.cpuUtilization : 0,
    0,
    1,
  );
  const pressure = Math.max(queueSaturation, cpuUtilization);
  const ceiling = Math.max(1, maxLoadMultiplier);
  const multiplier =
    pressure <= 0.7 ? 1 : 1 + ((pressure - 0.7) / 0.3) * (ceiling - 1);
  const roundedMultiplier = Number(clamp(multiplier, 1, ceiling).toFixed(4));
  return {
    jobKind,
    priceSats: Math.ceil(basePriceSats * roundedMultiplier),
    basePriceSats,
    multiplier: roundedMultiplier,
    queueSaturation: Number(queueSaturation.toFixed(4)),
    cpuUtilization: Number(cpuUtilization.toFixed(4)),
    load: Number(pressure.toFixed(4)),
  };
}

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
  loadProvider?: () => SystemLoad;
  maxLoadMultiplier?: number;
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
    jobQuote(
      jobKind,
      load = input?.loadProvider?.() ?? {
        queueLength: 0,
        queueCapacity: 1,
        cpuUtilization: 0,
      },
    ) {
      return calculateJobPrice(jobKind, load, input?.maxLoadMultiplier);
    },
  };
}
