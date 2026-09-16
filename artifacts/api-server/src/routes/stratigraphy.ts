import {
  GetPaidStratigraphyResponse,
  ReadinessCheckResponse,
} from "@workspace/api-zod";
import {
  type Express,
  type Request,
  type Response,
} from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createMemoryPaymentChallengeStore,
  type PaymentChallengeStore,
} from "../lib/payment-challenge-store";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  getMacaroonSignatureId,
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
  verifySubscriptionMacaroon,
} from "../lib/subscription-pass";
import {
  createMemoryMacaroonUsageStore,
  type MacaroonUsageStore,
} from "../lib/macaroon-usage-store";
import {
  createMemoryMacaroonRevocationStore,
  type MacaroonRevocationStore,
} from "../lib/macaroon-revocation-store";
import {
  createPricingEngine,
  type PricingEngine,
} from "../services/pricing";
import {
  createDefaultSettlementRouter,
  createNwcClient,
  type NwcClientFactory,
  type SettlementRouter,
} from "../services/settlement";
import {
  createStratigraphyTelemetryHub,
  nodeIntervalScheduler,
  readLiveBitcoinTelemetry,
  type IntervalScheduler,
  type StratigraphyTelemetryHub,
} from "../services/stratigraphy-stream";

const MIN_INVOICE_SATS = 5;
const LATEST_DATASET_DATE_MS = Date.UTC(2026, 8, 9);
const DAY_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_REUSE_MS = 5 * 60 * 1000;
const INVOICE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_INVOICES_PER_WINDOW = 5;
const MAX_CHALLENGE_CALLERS = 10_000;
const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: [
      "day",
      "title",
      "video_id",
      "transcript_summary",
      "quantitative_alpha",
    ],
    properties: {
      day: { type: "integer" },
      title: { type: "string" },
      video_id: { type: "string" },
      transcript_summary: { type: "string" },
      quantitative_alpha: {
        type: "object",
        required: [
          "target_multiplier",
          "difficulty_epoch_progress",
          "thermodynamic_signal",
        ],
        properties: {
          target_multiplier: { type: "number" },
          difficulty_epoch_progress: { type: "string" },
          thermodynamic_signal: { type: "string" },
        },
      },
    },
  },
} as const;
const datasetPath = fileURLToPath(
  new URL("../data/stratigraphy.json", import.meta.url),
);

type RawStratigraphyEntry = {
  day?: unknown;
  title?: unknown;
  quantitative_alpha?: {
    target_multiplier?: unknown;
    difficulty_epoch_progress?: unknown;
    thermodynamic_signal?: unknown;
  };
  [key: string]: unknown;
};

function targetMultiplier(title: unknown) {
  if (typeof title !== "string") return 0;
  const match = /(\d+(?:\.\d+)?)\s*[x×]\s*away/i.exec(title);
  return match ? Number(match[1]) : 0;
}

function difficultyEpochProgress(day: unknown) {
  if (typeof day !== "number" || !Number.isInteger(day) || day < 1) {
    return "0.00%";
  }
  return `${((((day - 1) % 14) + 1) / 14 * 100).toFixed(2)}%`;
}

function thermodynamicSignal(multiplier: number) {
  if (multiplier >= 120) return "extended-target-distance";
  if (multiplier >= 100) return "elevated-target-distance";
  if (multiplier > 0) return "compressed-target-distance";
  return "signal-unavailable";
}

function supplyQuantitativeAlpha(
  entry: RawStratigraphyEntry,
  previousMultiplier: number,
) {
  const derivedMultiplier = targetMultiplier(entry.title);
  const supplied = entry.quantitative_alpha;
  const multiplier =
    typeof supplied?.target_multiplier === "number" &&
    Number.isFinite(supplied.target_multiplier)
      ? supplied.target_multiplier
      : derivedMultiplier || previousMultiplier;

  return {
    ...entry,
    quantitative_alpha: {
      target_multiplier: multiplier,
      difficulty_epoch_progress:
        typeof supplied?.difficulty_epoch_progress === "string"
          ? supplied.difficulty_epoch_progress
          : difficultyEpochProgress(entry.day),
      thermodynamic_signal:
        typeof supplied?.thermodynamic_signal === "string"
          ? supplied.thermodynamic_signal
          : thermodynamicSignal(multiplier),
    },
  };
}

async function readValidatedDataset() {
  const raw = await readFile(datasetPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  let previousMultiplier = 0;
  const supplied = Array.isArray(parsed)
    ? parsed.map((entry) => {
        const suppliedEntry = supplyQuantitativeAlpha(
          typeof entry === "object" && entry !== null
            ? (entry as RawStratigraphyEntry)
            : {},
          previousMultiplier,
        );
        previousMultiplier = suppliedEntry.quantitative_alpha.target_multiplier;
        return suppliedEntry;
      })
    : parsed;
  return GetPaidStratigraphyResponse.parse(supplied);
}

let datasetPromise: ReturnType<typeof readValidatedDataset> | undefined;

export function readDataset() {
  datasetPromise ??= readValidatedDataset();
  return datasetPromise;
}

export async function refreshDataset() {
  const refreshed = await readValidatedDataset();
  datasetPromise = Promise.resolve(refreshed);
  return refreshed;
}

type ChallengePolicy = {
  now: () => number;
  reuseMs: number;
  limitWindowMs: number;
  maxInvoicesPerWindow: number;
  maxCallers: number;
};
type Dataset = Awaited<ReturnType<typeof readDataset>>;
export type StratigraphyFilter = {
  days?: number;
  from?: string;
  date?: string;
};
type SelectedRange = {
  records: Dataset;
  amountMsats: number;
  description: string;
  key: string;
};

class InvoiceCreationError extends Error {
  constructor(cause: unknown) {
    super("Unable to create payment invoice", { cause });
  }
}

const defaultChallengePolicy: ChallengePolicy = {
  now: Date.now,
  reuseMs: CHALLENGE_REUSE_MS,
  limitWindowMs: INVOICE_LIMIT_WINDOW_MS,
  maxInvoicesPerWindow: MAX_INVOICES_PER_WINDOW,
  maxCallers: MAX_CHALLENGE_CALLERS,
};

function callerKey(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function singleQueryValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function dateIndex(value: string, datasetLength: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "date must use YYYY-MM-DD";
  const dateMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  if (new Date(dateMs).toISOString().slice(0, 10) !== value) {
    return "date must be a valid calendar date";
  }
  const firstDateMs = LATEST_DATASET_DATE_MS - (datasetLength - 1) * DAY_MS;
  if (dateMs < firstDateMs || dateMs > LATEST_DATASET_DATE_MS) {
    return `date must be between ${new Date(firstDateMs).toISOString().slice(0, 10)} and 2026-09-09`;
  }
  return (dateMs - firstDateMs) / DAY_MS;
}

function filterDataset(
  dataset: Dataset,
  filter: StratigraphyFilter,
): Dataset | string {
  const selectedFilters = [
    filter.days !== undefined,
    filter.from !== undefined,
    filter.date !== undefined,
  ].filter(Boolean).length;
  if (selectedFilters > 1) {
    return "days, from, and date cannot be combined";
  }
  if (filter.days !== undefined) {
    if (
      !Number.isInteger(filter.days) ||
      filter.days < 1 ||
      filter.days > dataset.length
    ) {
      return `days must be an integer between 1 and ${dataset.length}`;
    }
    return dataset.slice(-filter.days);
  }
  const dateValue = filter.from ?? filter.date;
  if (dateValue !== undefined) {
    const index = dateIndex(dateValue, dataset.length);
    if (typeof index === "string") {
      return filter.from === undefined
        ? index
        : index.replaceAll("date", "from");
    }
    return filter.date === undefined
      ? dataset.slice(index)
      : dataset.slice(index, index + 1);
  }
  return dataset;
}

export async function getStratigraphyData(filter: StratigraphyFilter = {}) {
  const result = filterDataset(await readDataset(), filter);
  if (typeof result === "string") {
    throw new RangeError(result);
  }
  return result;
}

function currentDifficultyEpochProgress(dataset: Dataset) {
  const raw = dataset.at(-1)?.quantitative_alpha.difficulty_epoch_progress;
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
}

function selectRange(req: Request, dataset: Dataset): SelectedRange | string {
  const daysValue = singleQueryValue(req.query.days);
  const fromValue = singleQueryValue(req.query.from);
  if (req.query.days !== undefined && daysValue === undefined) {
    return "days must be a single integer";
  }
  if (req.query.from !== undefined && fromValue === undefined) {
    return "from must be a single date";
  }
  if (daysValue !== undefined && fromValue !== undefined) {
    return "days and from cannot be used together";
  }

  let filter: StratigraphyFilter = {};
  if (daysValue !== undefined) {
    if (!/^[1-9]\d*$/.test(daysValue)) {
      return "days must be an integer between 1 and 422";
    }
    filter = { days: Number(daysValue) };
  } else if (fromValue !== undefined) {
    filter = { from: fromValue };
  }
  const records = filterDataset(dataset, filter);
  if (typeof records === "string") {
    return records;
  }

  const firstDay = records[0].day;
  const lastDay = records.at(-1)!.day;
  const count = records.length;
  const amountSats = Math.max(MIN_INVOICE_SATS, count);
  const dayLabel = count === 1 ? "day" : "days";
  return {
    records,
    amountMsats: amountSats * 1_000,
    description: `Bitcoin Stratigraphy days ${firstDay}-${lastDay} (${count} ${dayLabel}) access`,
    key: `${firstDay}-${lastDay}`,
  };
}

function parseL402Authorization(value: string | undefined) {
  if (!value) return null;

  const match = /^L402\s+([^:\s]+):([0-9a-fA-F]{64})$/.exec(
    value.trim(),
  );
  if (!match) return null;

  return /^[0-9a-fA-F]{64}$/.test(match[1])
    ? {
        kind: "legacy" as const,
        paymentHash: match[1].toLowerCase(),
        preimage: match[2].toLowerCase(),
      }
    : {
        kind: "subscription" as const,
        macaroon: match[1],
        preimage: match[2].toLowerCase(),
      };
}

function operatorAuthorized(value: string | undefined, secret: string) {
  const match = /^Bearer\s+(.+)$/.exec(value?.trim() ?? "");
  if (!match) return false;
  const supplied = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(supplied, expected);
}

async function rejectRevokedMacaroon(
  req: Request,
  res: Response,
  macaroon: string,
  revocationStore: MacaroonRevocationStore,
  signal?: AbortSignal,
) {
  const signatureId = getMacaroonSignatureId(macaroon);
  if (!signatureId) return false;
  try {
    if (!(await revocationStore.isRevoked(signatureId, signal))) return false;
    res.status(401).json({ error: "Token has been revoked" });
    return true;
  } catch (error) {
    if (signal?.aborted) return true;
    req.log.error({ err: error }, "Macaroon revocation lookup failed");
    res.status(503).json({ error: "Token revocation service unavailable" });
    return true;
  }
}

function sendPaidDataset(
  res: Response,
  records: Dataset,
  paymentHash: string,
  timestampMs: number,
): void {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "SESSION_SECRET is not configured" });
    return;
  }
  const body = JSON.stringify(records);
  const payloadSha256 = createHash("sha256").update(body).digest("hex");
  const timestamp = new Date(timestampMs).toISOString();
  const signature = createHmac("sha256", secret)
    .update(payloadSha256 + paymentHash + timestamp)
    .digest("hex");
  res.setHeader(
    "X-L402-Receipt",
    JSON.stringify({
      payload_sha256: payloadSha256,
      payment_hash: paymentHash,
      timestamp,
      signature,
    }),
  );
  res.status(200).type("application/json").send(body);
}

async function sendPaymentChallenge(
  req: Request,
  res: Response,
  settlementRouter: SettlementRouter,
  challengeStore: PaymentChallengeStore,
  policy: ChallengePolicy,
  caller: string,
  rangeKey: string,
  amountMsats: number,
  description: string,
  pricingEngine: PricingEngine,
  difficultyEpochProgress: number,
) {
  try {
    const getChallenge = async (
      scope: string,
      challengeAmountMsats: number,
      challengeDescription: string,
    ) => {
      const providerScope =
        `${scope}:settlement:${settlementRouter.activeProvider()}`;
      return challengeStore.getOrCreate(
        caller,
        providerScope,
        policy,
        async () => {
          try {
            const challenge = await settlementRouter.createInvoice({
              amountMsats: challengeAmountMsats,
              description: challengeDescription,
              expirySeconds: 3600,
            });
            return { ...challenge, issuedAt: policy.now() };
          } catch (error) {
            throw new InvoiceCreationError(error);
          }
        },
        (challenge) =>
          `${scope}:settlement:${
            challenge.provider ?? settlementRouter.activeProvider()
          }`,
      );
    };
    const legacyResult = await getChallenge(rangeKey, amountMsats, description);
    if (legacyResult.kind === "limited") {
      res.setHeader("Retry-After", String(legacyResult.retryAfter));
      res.status(429).json({
        error: "Too many payment invoices requested",
        code: "payment_challenge_rate_limited",
        retry_after: legacyResult.retryAfter,
      });
      return;
    }
    const passResults = await Promise.all(
      (Object.keys(SUBSCRIPTION_TIERS) as SubscriptionTier[]).map(
        async (tier) => {
          const definition = SUBSCRIPTION_TIERS[tier];
          const pricing = pricingEngine.quote(
            tier,
            difficultyEpochProgress,
            policy.now(),
          );
          const amountMsats = pricing.priceSats * 1_000;
          const result = await getChallenge(
            `subscription:${tier}:${amountMsats}`,
            amountMsats,
            definition.description,
          );
          return { tier, definition, pricing, amountMsats, result };
        },
      ),
    );
    const limited = passResults.find(({ result }) => result.kind === "limited");
    if (limited?.result.kind === "limited") {
      res.setHeader("Retry-After", String(limited.result.retryAfter));
      res.status(429).json({
        error: "Too many payment invoices requested",
        code: "payment_challenge_rate_limited",
        retry_after: limited.result.retryAfter,
      });
      return;
    }
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      res.status(500).json({ error: "SESSION_SECRET is not configured" });
      return;
    }
    const passes = passResults.map(
      ({ tier, definition, pricing, amountMsats, result }) => {
      if (result.kind !== "challenge") throw new Error("unreachable");
      const validUntil =
        Math.floor(result.challenge.issuedAt / 1000) +
        60 * 60 +
        definition.durationSeconds;
      return {
        tier,
        invoice: result.challenge.invoice,
        payment_hash: result.challenge.paymentHash,
        macaroon: createSubscriptionMacaroon({
          secret,
          paymentHash: result.challenge.paymentHash,
          tier,
          validUntil,
          amountMsats,
        }),
        valid_until: validUntil,
        price_sats: pricing.priceSats,
      };
      },
    );

    res.setHeader(
      "WWW-Authenticate",
      [
        `L402 macaroon="${legacyResult.challenge.paymentHash}", invoice="${legacyResult.challenge.invoice}"`,
        ...passes.map(
          (pass) =>
            `L402 macaroon="${pass.macaroon}", invoice="${pass.invoice}", tier="${pass.tier}"`,
        ),
      ],
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(402).json({
      invoice: legacyResult.challenge.invoice,
      payment_hash: legacyResult.challenge.paymentHash,
      passes,
    });
  } catch (error) {
    req.log.error({ err: error }, "Payment challenge creation failed");
    if (error instanceof InvoiceCreationError) {
      res.status(502).json({ error: "Unable to create payment invoice" });
      return;
    }
    res.status(503).json({ error: "Payment challenge service unavailable" });
  }
}

export function registerStratigraphyRoutes(
  app: Express,
  clientFactory: NwcClientFactory = createNwcClient,
  policy: ChallengePolicy = defaultChallengePolicy,
  challengeStore: PaymentChallengeStore = createMemoryPaymentChallengeStore(),
  macaroonUsageStore: MacaroonUsageStore = createMemoryMacaroonUsageStore(),
  revocationStore: MacaroonRevocationStore =
    createMemoryMacaroonRevocationStore(),
  pricingEngine: PricingEngine = createPricingEngine(),
  settlementRouter: SettlementRouter =
    createDefaultSettlementRouter(clientFactory),
  streamOptions: {
    telemetryHub?: StratigraphyTelemetryHub;
    heartbeatScheduler?: IntervalScheduler;
  } = {},
): void {
  const telemetryHub =
    streamOptions.telemetryHub ??
    createStratigraphyTelemetryHub({
      async readTelemetry() {
        const latest = (await readDataset()).at(-1);
        return readLiveBitcoinTelemetry({
          epochProgressPercent: currentDifficultyEpochProgress(
            latest ? [latest] : [],
          ),
          thermodynamicSignal:
            latest?.quantitative_alpha.thermodynamic_signal ??
            "signal-unavailable",
          targetMultiplier:
            latest?.quantitative_alpha.target_multiplier ?? 0,
          now: policy.now,
        });
      },
    });
  const heartbeatScheduler =
    streamOptions.heartbeatScheduler ?? nodeIntervalScheduler;
  app.use("/api/v1", (_req, _res, next) => {
    pricingEngine.recordRequest(policy.now());
    next();
  });

  app.get("/api", (_req, res): void => {
    res.status(200).json({
      status: "online",
      service: "Bitcoin Stratigraphy API",
    });
  });

  app.get("/api/readyz", async (req, res): Promise<void> => {
    const walletConfiguration = settlementRouter.isConfigured()
      ? "available"
      : "unavailable";
    let challengeCoordination = "available";
    try {
      await challengeStore.checkHealth();
    } catch (error) {
      challengeCoordination = "unavailable";
      req.log.error(
        { err: error },
        "Payment challenge readiness check failed",
      );
    }
    const ready =
      walletConfiguration === "available" &&
      challengeCoordination === "available";
    const data = ReadinessCheckResponse.parse({
      status: ready ? "ready" : "not_ready",
      dependencies: {
        wallet_configuration: walletConfiguration,
        challenge_coordination: challengeCoordination,
      },
    });
    res.status(ready ? 200 : 503).json(data);
  });

  app.get("/api/v1/stratigraphy/sample", async (_req, res): Promise<void> => {
    const data = await readDataset();
    res.status(200).json(data.slice(-5));
  });

  app.get("/api/v1/cost", async (_req, res): Promise<void> => {
    const dataset = await readDataset();
    const epochProgress = currentDifficultyEpochProgress(dataset);
    const calculatedAt = policy.now();
    const quotes = (Object.keys(SUBSCRIPTION_TIERS) as SubscriptionTier[]).map(
      (tier) => pricingEngine.quote(tier, epochProgress, calculatedAt),
    );
    res.setHeader(
      "X-L402-Subscription-Tiers",
      quotes.map(({ tier, priceSats }) => `${tier}=${priceSats}`).join(", "),
    );
    res.status(200).json({
      protocol: "L402",
      access_tiers: quotes.map((quote) => ({
        id: quote.tier,
        duration_days: quote.tier === "1-day" ? 1 : 30,
        price_sats: quote.priceSats,
        base_price_sats: quote.basePriceSats,
        max_price_sats: quote.maxPriceSats,
        multiplier: quote.multiplier,
      })),
      dynamic_pricing: {
        difficulty_epoch_progress: epochProgress,
        request_velocity_rpm: pricingEngine.requestVelocity(calculatedAt),
        calculated_at: new Date(calculatedAt).toISOString(),
      },
      legacy_query_pricing: {
        sats_per_day: 1,
        minimum_sats: MIN_INVOICE_SATS,
      },
      dataset: {
        days: dataset.length,
        first_day: dataset[0].day,
        last_day: dataset.at(-1)!.day,
        grows_over_time: true,
      },
      mcp_tool: {
        name: "get_bitcoin_stratigraphy",
        parameters: {
          days: {
            type: "integer",
            minimum: 1,
            maximum: dataset.length,
            required: false,
          },
          date: {
            type: "string",
            format: "date",
            required: false,
          },
        },
      },
      response_schema: RESPONSE_SCHEMA,
    });
  });

  app.post(
    "/api/v1/macaroon/revoke",
    async (req: Request, res: Response): Promise<void> => {
      const operatorSecret = process.env.MACAROON_OPERATOR_SECRET;
      if (!operatorSecret) {
        res.status(503).json({ error: "Macaroon revocation is not configured" });
        return;
      }
      if (!operatorAuthorized(req.header("Authorization"), operatorSecret)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const macaroon =
        typeof req.body?.macaroon === "string" ? req.body.macaroon : undefined;
      const suppliedSignatureId =
        typeof req.body?.signature_id === "string"
          ? req.body.signature_id.toLowerCase()
          : undefined;
      if (
        (macaroon ? 1 : 0) + (suppliedSignatureId ? 1 : 0) !== 1 ||
        (suppliedSignatureId &&
          !/^[0-9a-f]{64}$/.test(suppliedSignatureId))
      ) {
        res.status(400).json({
          error: "Provide exactly one valid macaroon or signature_id",
        });
        return;
      }
      const signatureId = macaroon
        ? getMacaroonSignatureId(macaroon)
        : suppliedSignatureId!;
      if (!signatureId) {
        res.status(400).json({ error: "Invalid macaroon" });
        return;
      }
      const reason =
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 500)
          : undefined;
      try {
        const revocation = await revocationStore.revoke(signatureId, reason);
        res.status(200).json({
          signature_id: revocation.signatureId,
          revoked_at: revocation.revokedAt.toISOString(),
          ...(revocation.reason ? { reason: revocation.reason } : {}),
        });
      } catch (error) {
        req.log.error({ err: error }, "Macaroon revocation failed");
        res.status(503).json({ error: "Token revocation service unavailable" });
      }
    },
  );

  app.post(
    "/api/v1/macaroon/attenuate",
    async (req: Request, res: Response): Promise<void> => {
      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      const parentMacaroon =
        typeof req.body?.macaroon === "string" ? req.body.macaroon : undefined;
      const rawCaveats: unknown = req.body?.caveats;
      const caveats =
        Array.isArray(rawCaveats) &&
        rawCaveats.every((caveat): caveat is string => typeof caveat === "string")
          ? rawCaveats
          : undefined;
      const secret = process.env.SESSION_SECRET;
      if (
        !secret ||
        !authorization ||
        authorization.kind !== "subscription" ||
        parentMacaroon !== authorization.macaroon ||
        !caveats ||
        caveats.length === 0
      ) {
        res.status(400).json({ error: "Invalid attenuation request" });
        return;
      }
      if (
        await rejectRevokedMacaroon(
          req,
          res,
          parentMacaroon,
          revocationStore,
        )
      ) {
        return;
      }
      const parent = verifySubscriptionMacaroon(
        parentMacaroon,
        secret,
        Math.floor(policy.now() / 1000),
      );
      if (!parent) {
        res.status(401).json({ error: "Invalid parent macaroon" });
        return;
      }
      if (!settlementRouter.isConfigured()) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }
      const definition = SUBSCRIPTION_TIERS[parent.tier];
      const verification = await settlementRouter.verifyPayment({
        paymentHash: parent.paymentHash,
        preimage: authorization.preimage,
        expectedAmountMsats: parent.amountMsats ?? definition.amountMsats,
        expectedDescription: definition.description,
      });
      if (verification === "unavailable") {
        res.status(502).json({ error: "Unable to verify payment" });
        return;
      }
      if (
        typeof verification !== "object" ||
        verification.settledAt <= 0 ||
        Math.floor(policy.now() / 1000) >=
          verification.settledAt + definition.durationSeconds
      ) {
        res.status(401).json({ error: "Invalid parent macaroon" });
        return;
      }
      const macaroon = attenuateSubscriptionMacaroon(parentMacaroon, caveats);
      if (!macaroon) {
        res.status(400).json({ error: "Invalid attenuation caveats" });
        return;
      }
      const child = verifySubscriptionMacaroon(
        macaroon,
        secret,
        Math.floor(policy.now() / 1000),
      );
      res.status(200).json({
        macaroon,
        caveats: child
          ? {
              allowed_path: child.allowedPaths,
              max_requests: child.maxRequests,
            }
          : undefined,
      });
    },
  );

  app.head(
    "/api/v1/stratigraphy",
    async (req: Request, res: Response): Promise<void> => {
      const dataset = await readDataset();
      const selectedRange = selectRange(req, dataset);
      if (typeof selectedRange === "string") {
        res.status(400).end();
        return;
      }
      res.setHeader("X-Stratigraphy-Records", String(selectedRange.records.length));
      res.setHeader(
        "X-Stratigraphy-First-Day",
        String(selectedRange.records[0].day),
      );
      res.setHeader(
        "X-Stratigraphy-Last-Day",
        String(selectedRange.records.at(-1)!.day),
      );
      res.setHeader(
        "X-L402-Cost-Sats",
        String(selectedRange.amountMsats / 1_000),
      );
      res.setHeader("X-L402-Minimum-Cost-Sats", String(MIN_INVOICE_SATS));
      res.setHeader(
        "X-L402-Subscription-Tiers",
        (Object.keys(SUBSCRIPTION_TIERS) as SubscriptionTier[])
          .map((tier) => {
            const quote = pricingEngine.quote(
              tier,
              currentDifficultyEpochProgress(dataset),
              policy.now(),
            );
            return `${tier}=${quote.priceSats}`;
          })
          .join(", "),
      );
      res.status(200).end();
    },
  );

  app.get(
    "/api/v1/stratigraphy/stream",
    async (req: Request, res: Response): Promise<void> => {
      const requestController = new AbortController();
      let disconnected = req.destroyed || res.destroyed;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: unknown;
      let waitingForDrain = false;
      const drained = () => {
        waitingForDrain = false;
      };
      const close = () => {
        if (disconnected && !unsubscribe && heartbeat === undefined) return;
        disconnected = true;
        requestController.abort(
          new DOMException("SSE client disconnected", "AbortError"),
        );
        res.off("drain", drained);
        if (heartbeat !== undefined) {
          heartbeatScheduler.clearInterval(heartbeat);
          heartbeat = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
      };
      req.once("aborted", close);
      res.once("close", close);

      const dataset = await readDataset();
      if (disconnected) return;
      const selectedRange = selectRange(req, dataset);
      if (typeof selectedRange === "string") {
        res.status(400).json({
          error: "Invalid stratigraphy range",
          detail: selectedRange,
        });
        return;
      }
      const caller = callerKey(req);
      if (!settlementRouter.isConfigured()) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      let paymentHash: string | undefined;
      if (authorization?.kind === "subscription") {
        if (
          await rejectRevokedMacaroon(
            req,
            res,
            authorization.macaroon,
            revocationStore,
            requestController.signal,
          )
        ) {
          return;
        }
        const secret = process.env.SESSION_SECRET;
        const pass =
          secret &&
          verifySubscriptionMacaroon(
            authorization.macaroon,
            secret,
            Math.floor(policy.now() / 1000),
          );
        if (pass) {
          if (
            pass.allowedPaths.some((allowedPath) => allowedPath !== req.path)
          ) {
            res.status(403).json({ error: "Macaroon path is not allowed" });
            return;
          }
          const definition = SUBSCRIPTION_TIERS[pass.tier];
          let verification;
          try {
            verification = await settlementRouter.verifyPayment({
              paymentHash: pass.paymentHash,
              preimage: authorization.preimage,
              expectedAmountMsats:
                pass.amountMsats ?? definition.amountMsats,
              expectedDescription: definition.description,
              signal: requestController.signal,
            });
          } catch (error) {
            if (disconnected) return;
            throw error;
          }
          if (disconnected) return;
          if (verification === "unavailable") {
            res.status(502).json({ error: "Unable to verify payment" });
            return;
          }
          if (
            typeof verification === "object" &&
            verification.settledAt > 0 &&
            Math.floor(policy.now() / 1000) <
              verification.settledAt + definition.durationSeconds
          ) {
            if (
              pass.maxRequests !== undefined &&
              !(await macaroonUsageStore.consume(
                pass.requestLimits,
                pass.validUntil,
                requestController.signal,
              ))
            ) {
              if (disconnected) return;
              res.status(429).json({
                error: "Macaroon request limit exhausted",
              });
              return;
            }
            paymentHash = pass.paymentHash;
          }
        }
      }

      if (!paymentHash) {
        if (disconnected) return;
        await sendPaymentChallenge(
          req,
          res,
          settlementRouter,
          challengeStore,
          policy,
          caller,
          `stream:${selectedRange.key}`,
          selectedRange.amountMsats,
          selectedRange.description,
          pricingEngine,
          currentDifficultyEpochProgress(dataset),
        );
        return;
      }

      if (disconnected || res.destroyed) return;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const writeEvent = (event: "telemetry" | "ping", data: unknown) => {
        if (
          disconnected ||
          waitingForDrain ||
          res.destroyed ||
          res.writableEnded
        ) {
          return;
        }
        if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
          waitingForDrain = true;
          res.once("drain", drained);
        }
      };
      unsubscribe = telemetryHub.subscribe((telemetry) => {
        writeEvent("telemetry", telemetry);
      });
      if (disconnected) {
        close();
        return;
      }
      heartbeat = heartbeatScheduler.setInterval(() => {
        writeEvent("ping", {
          observed_at: new Date(policy.now()).toISOString(),
        });
      }, 15_000);
      if (disconnected) close();
    },
  );

  app.get(
    "/api/v1/stratigraphy",
    async (req: Request, res: Response): Promise<void> => {
      const dataset = await readDataset();
      const selectedRange = selectRange(req, dataset);
      if (typeof selectedRange === "string") {
        res.status(400).json({
          error: "Invalid stratigraphy range",
          detail: selectedRange,
        });
        return;
      }
      const caller = callerKey(req);
      if (!settlementRouter.isConfigured()) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      if (authorization) {
        if (authorization.kind === "subscription") {
          if (
            await rejectRevokedMacaroon(
              req,
              res,
              authorization.macaroon,
              revocationStore,
            )
          ) {
            return;
          }
          const secret = process.env.SESSION_SECRET;
          const pass =
            secret &&
            verifySubscriptionMacaroon(
              authorization.macaroon,
              secret,
              Math.floor(policy.now() / 1000),
            );
          if (pass) {
            if (
              pass.allowedPaths.some((allowedPath) => allowedPath !== req.path)
            ) {
              res.status(403).json({ error: "Macaroon path is not allowed" });
              return;
            }
            const definition = SUBSCRIPTION_TIERS[pass.tier];
            const verification = await settlementRouter.verifyPayment({
              paymentHash: pass.paymentHash,
              preimage: authorization.preimage,
              expectedAmountMsats:
                pass.amountMsats ?? definition.amountMsats,
              expectedDescription: definition.description,
            });
            if (verification === "unavailable") {
              res.status(502).json({ error: "Unable to verify payment" });
              return;
            }
            if (
              typeof verification === "object" &&
              verification.settledAt > 0 &&
              Math.floor(policy.now() / 1000) <
                verification.settledAt + definition.durationSeconds
            ) {
              if (
                pass.maxRequests !== undefined &&
                !(await macaroonUsageStore.consume(
                  pass.requestLimits,
                  pass.validUntil,
                ))
              ) {
                res.status(429).json({
                  error: "Macaroon request limit exhausted",
                });
                return;
              }
              sendPaidDataset(
                res,
                selectedRange.records,
                pass.paymentHash,
                policy.now(),
              );
              return;
            }
          }
        }
        if (authorization.kind === "legacy") {
        const verification = await settlementRouter.verifyPayment({
          paymentHash: authorization.paymentHash,
          preimage: authorization.preimage,
          expectedAmountMsats: selectedRange.amountMsats,
          expectedDescription: selectedRange.description,
        });
        if (verification === "unavailable") {
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (typeof verification === "object") {
          try {
            await challengeStore.consume(
              caller,
              selectedRange.key,
              authorization.paymentHash,
            );
          } catch (error) {
            req.log.error(
              { err: error },
              "Unable to remove consumed payment challenge",
            );
          }
          sendPaidDataset(
            res,
            selectedRange.records,
            authorization.paymentHash,
            policy.now(),
          );
          return;
        }
        }
      }

      await sendPaymentChallenge(
        req,
        res,
        settlementRouter,
        challengeStore,
        policy,
        caller,
        selectedRange.key,
        selectedRange.amountMsats,
        selectedRange.description,
        pricingEngine,
        currentDifficultyEpochProgress(dataset),
      );
    },
  );

  app.get("/llms.txt", (_req, res): void => {
    res.type("text/plain").send(`# Bitcoin Stratigraphy API

Machine-readable OpenAPI: GET /openapi.json
Free sample: GET /api/v1/stratigraphy/sample
Paid dataset: GET /api/v1/stratigraphy

Legacy single-query access costs one satoshi per selected day with a five-satoshi
minimum. The same HTTP 402 response offers dynamically priced 1-Day and 30-Day
passes; query GET /api/v1/cost for the current bounded price. Passes allow
unlimited queries until their signed
valid_until caveat and settlement-based entitlement expiry. After payment, retry
with:

Authorization: L402 <payment_hash>:<preimage>

For a pass, use:

Authorization: L402 <signed_macaroon>:<preimage>
`);
  });
}
