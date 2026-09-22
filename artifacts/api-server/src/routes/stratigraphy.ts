import {
  GetPaidStratigraphyResponse,
  ReadinessCheckResponse,
  VerifyZkProofBody,
  VerifyZkProofResponse,
} from "@workspace/api-zod";
import {
  type Express,
  type Request,
  type Response,
} from "express";
import { createL402Middleware } from "../middleware/l402";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
  createNwcClient,
  type NwcClientFactory,
  type SettlementRouter,
  SETTLEMENT_ASSETS,
  type SettlementAsset,
} from "../services/settlement";
import {
  createDefaultMultiSettlementRouter,
  isSettlementAsset,
  type MultiSettlementRouter,
} from "../services/multiSettlement";
import {
  createStratigraphyTelemetryHub,
  nodeIntervalScheduler,
  readLiveBitcoinTelemetry,
  type IntervalScheduler,
  type StratigraphyTelemetryHub,
} from "../services/stratigraphy-stream";
import {
  createCachedNostrAttestor,
  createNostrAttestor,
  type NostrAttestor,
} from "../services/nostrAttestation";
import {
  createAgentReputationService,
  type AgentIdentity,
  type AgentReputationService,
} from "../services/agentReputation";
import {
  generateZkProof,
  verifyZkProof,
  verifyZkProofForSnapshot,
  ZkVerifierOverloadedError,
} from "../services/zkProofService";
import {
  generateCryptographicAttestation,
  verifyCryptographicAttestation,
} from "../services/attestation";
import {
  createMemoryRevenueLedger,
  paymentReference,
  recordRevenueWithRetry,
  type RevenueLedger,
} from "../services/ledger";
import {
  createHttpRateLimitMiddleware,
  createSlidingWindowRateLimiter,
  type SlidingWindowRateLimiter,
} from "../middleware/rateLimiter";
import { runtimePricingLoad } from "../services/orchestrator";
import {
  createMeshGossipService,
  MeshQuorumError,
  type MeshGossipService,
} from "../services/meshGossipService";

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
  return GetPaidStratigraphyResponse.shape.data.parse(supplied);
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

function requestSettlementAsset(
  req: Request,
): { asset: SettlementAsset } | { error: string } {
  const primary = req.header("X-Settlement-Asset")?.trim().toLowerCase();
  const fallback = req.header("Accept-Asset")?.trim().toLowerCase();
  if (primary && fallback && primary !== fallback) {
    return { error: "Conflicting settlement asset headers" };
  }
  const requested = primary || fallback || "btc-lightning";
  return isSettlementAsset(requested)
    ? { asset: requested }
    : { error: "Unsupported settlement asset" };
}

function supportedSettlementAssets(
  router: SettlementRouter,
): readonly SettlementAsset[] {
  return "supportedAssets" in router
    ? (router as MultiSettlementRouter).supportedAssets()
    : ["btc-lightning"];
}

function availableSettlementAssets(
  router: SettlementRouter,
): readonly SettlementAsset[] {
  return "availableAssets" in router
    ? (router as MultiSettlementRouter).availableAssets()
    : router.isConfigured()
      ? ["btc-lightning"]
      : [];
}

function requestNip98Url(req: Request): string {
  const configuredOrigin = process.env.NIP98_PUBLIC_ORIGIN;
  const origin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : `${req.protocol}://${req.get("host")}`;
  return new URL(req.originalUrl, `${origin}/`).toString();
}

function verifyRequestAgent(
  req: Request,
  reputation: AgentReputationService,
  nowMs: number,
  payload?: Uint8Array,
): { provided: boolean; identity?: AgentIdentity } {
  const supplemental = req.header("X-Nostr-Authorization");
  const primary = req.header("Authorization");
  const authorization =
    supplemental ?? (primary?.startsWith("Nostr ") ? primary : undefined);
  if (!authorization) return { provided: false };
  const identity = reputation.verifyNip98Authorization({
    authorization,
    method: req.method,
    url: requestNip98Url(req),
    nowSeconds: Math.floor(nowMs / 1_000),
    payload,
  });
  return identity ? { provided: true, identity } : { provided: true };
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

async function sendPaidDataset(
  res: Response,
  records: Dataset,
  paymentHash: string,
  timestampMs: number,
  attest: NostrAttestor,
  mesh: MeshGossipService,
): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "SESSION_SECRET is not configured" });
    return;
  }
  const createdAt = Math.floor(timestampMs / 1_000);
  const attestedRecords = records.map((record) => attest(record, createdAt));
  const proofTimestamp =
    Math.max(
      ...attestedRecords.map(
        (record) => record.attestation.event.created_at,
      ),
    ) * 1_000;
  let zkProof;
  try {
    zkProof = await generateZkProof({
      snapshot: attestedRecords,
      blockHeight: 0,
      timestamp: proofTimestamp,
      valuationMultiplier:
        records.at(-1)?.quantitative_alpha.target_multiplier ?? 0,
    });
  } catch {
    res.status(500).json({ error: "Unable to generate zk telemetry proof" });
    return;
  }
  let meshConsensus;
  try {
    meshConsensus = await mesh.createConsensus(attestedRecords);
  } catch (error) {
    if (error instanceof MeshQuorumError) {
      res.status(503).json({ error: "Mesh consensus quorum unavailable" });
      return;
    }
    throw error;
  }
  const body = JSON.stringify({ data: attestedRecords, zkProof, meshConsensus });
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
  reputation: AgentReputationService,
  paymentAsset: SettlementAsset,
  agent?: AgentIdentity,
) {
  try {
    const agentScope = agent ? `:agent:${agent.pubkey}` : "";
    const adjustedPolicy = agent
      ? {
          ...policy,
          maxInvoicesPerWindow: Math.max(
            1,
            Math.floor(
              policy.maxInvoicesPerWindow * agent.rateLimitMultiplier,
            ),
          ),
        }
      : policy;
    const getChallenge = async (
      scope: string,
      challengeAmountMsats: number,
      challengeDescription: string,
    ) => {
      const providerScope =
        `${scope}${agentScope}:asset:${paymentAsset}:settlement:${settlementRouter.activeProvider(paymentAsset)}`;
      return challengeStore.getOrCreate(
        caller,
        providerScope,
        adjustedPolicy,
        async () => {
          try {
            const challenge = await settlementRouter.createInvoice({
              amountMsats: challengeAmountMsats,
              description: challengeDescription,
              expirySeconds: 3600,
              asset: paymentAsset,
            });
            const issuedAt = policy.now();
            return {
              ...challenge,
              issuedAt,
              redeemUntil: issuedAt + 3_600_000,
            };
          } catch (error) {
            throw new InvoiceCreationError(error);
          }
        },
        (challenge) =>
          `${scope}${agentScope}:asset:${paymentAsset}:settlement:${
            challenge.provider ?? settlementRouter.activeProvider(paymentAsset)
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
          const adjustedPricing = reputation.applyPricing(
            pricing.priceSats,
            agent,
          );
          const amountMsats = adjustedPricing.priceSats * 1_000;
          const result = await getChallenge(
            `subscription:${tier}:${amountMsats}`,
            amountMsats,
            definition.description,
          );
          return {
            tier,
            definition,
            pricing,
            adjustedPricing,
            amountMsats,
            result,
          };
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
      ({ tier, definition, pricing, adjustedPricing, amountMsats, result }) => {
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
           paymentAsset,
           paymentProvider: result.challenge.provider,
          agentIdentity: agent,
        }),
        valid_until: validUntil,
        price_sats: adjustedPricing.priceSats,
        original_price_sats: pricing.priceSats,
        discount_sats: adjustedPricing.discountSats,
        discount_percent: adjustedPricing.discountPercent,
        agent_tier: adjustedPricing.tier,
        payment_asset: paymentAsset,
      };
      },
    );

    res.setHeader(
      "WWW-Authenticate",
      [
        `L402 macaroon="${legacyResult.challenge.paymentHash}", invoice="${legacyResult.challenge.invoice}"`,
        ...passes.map(
          (pass) =>
            `L402 macaroon="${pass.macaroon}", invoice="${pass.invoice}", tier="${pass.tier}", price_sats="${pass.price_sats}", agent_tier="${pass.agent_tier}"`,
        ),
      ],
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(402).json({
      invoice: legacyResult.challenge.invoice,
      payment_hash: legacyResult.challenge.paymentHash,
      settlement_asset: paymentAsset,
      supported_assets: supportedSettlementAssets(settlementRouter),
      available_assets: availableSettlementAssets(settlementRouter),
      agent: agent
        ? {
            pubkey: agent.pubkey,
            tier: agent.tier,
            discount_percent: agent.discountPercent,
            rate_limit_multiplier: agent.rateLimitMultiplier,
          }
        : undefined,
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
    createDefaultMultiSettlementRouter(clientFactory),
  streamOptions: {
    telemetryHub?: StratigraphyTelemetryHub;
    heartbeatScheduler?: IntervalScheduler;
    agentReputation?: AgentReputationService;
    meshService?: MeshGossipService;
    revenueLedger?: RevenueLedger;
    l402RateLimiter?: SlidingWindowRateLimiter;
  } = {},
): void {
  const attest = createNostrAttestor();
  const attestDataset = createCachedNostrAttestor(attest);
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
  const activeStreamEntitlements = new Set<string>();
  const heartbeatScheduler =
    streamOptions.heartbeatScheduler ?? nodeIntervalScheduler;
  const agentReputation =
    streamOptions.agentReputation ?? createAgentReputationService();
  const mesh = streamOptions.meshService ?? createMeshGossipService();
  const revenueLedger =
    streamOptions.revenueLedger ?? createMemoryRevenueLedger();
  const l402RateLimiter =
    streamOptions.l402RateLimiter ??
    createSlidingWindowRateLimiter({ limit: 10_000, windowMs: 60_000 });
  const l402RateLimitMiddleware =
    createHttpRateLimitMiddleware(l402RateLimiter);
  const recordL402Revenue = async (input: {
    req: Request;
    paymentHash: string;
    preimage: string;
    amountMsats: number;
    settledAt: number;
    clientIdentifier: string;
  }) => {
    try {
      await recordRevenueWithRetry(revenueLedger, {
        id: randomUUID(),
        timestamp: new Date(
          input.settledAt < 10_000_000_000
            ? input.settledAt * 1_000
            : input.settledAt,
        ).toISOString(),
        channel: "L402",
        requestKind: "stratigraphy",
        satsReceived: Math.ceil(input.amountMsats / 1_000),
        paymentHash: input.paymentHash,
        preimage: input.preimage,
        clientIdentifier: input.clientIdentifier,
      });
    } catch (error) {
      input.req.log.error(
        { err: error, paymentReference: paymentReference(input.paymentHash) },
        "L402 settlement ledger failed",
      );
    }
  };
  app.use("/api/v1", (_req, _res, next) => {
    pricingEngine.recordRequest(policy.now());
    next();
  });
  app.use((req, res, next) => {
    if (
      req.path === "/api/v1/stratigraphy" ||
      req.path === "/api/v1/stratigraphy/l402" ||
      req.path === "/api/v1/zk/attest"
    ) {
      l402RateLimitMiddleware(req, res, next);
      return;
    }
    next();
  });

  app.post(
    "/api/v1/zk/verify",
    async (req: Request, res: Response): Promise<void> => {
      const attestation = (req.body as { attestation?: unknown } | null)
        ?.attestation ?? req.body;
      if (
        req.body &&
        typeof req.body === "object" &&
        ("attestation" in req.body ||
          ("schema" in req.body &&
            "signature" in req.body &&
            "proof" in req.body))
      ) {
        res.status(200).json({
          valid: verifyCryptographicAttestation(attestation),
          verifiedAt: new Date().toISOString(),
          computationTimeMs: 0,
        });
        return;
      }
      const parsed = VerifyZkProofBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid zk proof payload" });
        return;
      }
      const startedAt = performance.now();
      let valid: boolean;
      try {
        valid = await verifyZkProofForSnapshot(
          parsed.data,
          parsed.data.data,
        );
      } catch (error) {
        if (error instanceof ZkVerifierOverloadedError) {
          res.status(503).json({ error: "zk verifier is busy" });
          return;
        }
        throw error;
      }
      res.status(200).json(VerifyZkProofResponse.parse({
        valid,
        verifiedAt: new Date().toISOString(),
        computationTimeMs: Number((performance.now() - startedAt).toFixed(3)),
      }));
    },
  );

  app.get(
    "/api/v1/stratigraphy/l402",
    async (req: Request, res: Response, next): Promise<void> => {
      const dataset = await readDataset();
      const selectedRange = selectRange(req, dataset);
      if (typeof selectedRange === "string") {
        res.status(400).json({
          error: "Invalid stratigraphy range",
          detail: selectedRange,
        });
        return;
      }
      res.locals.stratigraphyRecords = selectedRange.records;
      next();
    },
    createL402Middleware({
      amountSats: () =>
        pricingEngine.jobQuote?.("stratigraphy", runtimePricingLoad())
          .priceSats ?? 5,
      description: "Bitcoin Stratigraphy L402 telemetry access",
      settlementRouter,
      now: policy.now,
      usageStore: macaroonUsageStore,
      ledger: revenueLedger,
      requestKind: "stratigraphy",
    }),
    (_req: Request, res: Response): void => {
      res.status(200).json({ data: res.locals.stratigraphyRecords });
    },
  );

  app.post(
    "/api/v1/zk/attest",
    createL402Middleware({
      amountSats: () =>
        pricingEngine.jobQuote?.("zk-proof", runtimePricingLoad()).priceSats ??
        21,
      description: "Bitcoin Stratigraphy cryptographic attestation",
      settlementRouter,
      now: policy.now,
      usageStore: macaroonUsageStore,
      ledger: revenueLedger,
      requestKind: "zk-proof",
    }),
    (req: Request, res: Response): void => {
      const body = req.body as { payload?: unknown } | null;
      const payload = body &&
        Object.prototype.hasOwnProperty.call(body, "payload")
        ? body.payload
        : req.body;
      if (payload === undefined) {
        res.status(400).json({ error: "Attestation payload is required" });
        return;
      }
      try {
        res.status(200).json({
          attestation: generateCryptographicAttestation(payload, {
            timestamp: policy.now(),
          }),
        });
      } catch {
        res.status(400).json({ error: "Payload is not JSON serializable" });
      }
    },
  );

  app.get("/api/v1/mesh/status", (_req, res): void => {
    res.status(200).json(mesh.status());
  });

  app.post("/api/v1/mesh/attest", (req, res): void => {
    const body = req.body as Record<string, unknown> | null;
    if (
      !body ||
      Object.keys(body).length !== 4 ||
      typeof body.snapshotDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.snapshotDigest) ||
      typeof body.networkId !== "string" ||
      typeof body.originPubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.originPubkey) ||
      !("snapshot" in body)
    ) {
      res.status(400).json({ error: "Invalid mesh attestation request" });
      return;
    }
    try {
      res.status(200).json({
        event: mesh.attestSnapshot({
          snapshot: body.snapshot,
          snapshotDigest: body.snapshotDigest,
          networkId: body.networkId,
          originPubkey: body.originPubkey,
        }),
      });
    } catch {
      res.status(422).json({ error: "Mesh snapshot validation failed" });
    }
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

  app.get("/api/v1/cost", async (req, res): Promise<void> => {
    const assetSelection = requestSettlementAsset(req);
    if ("error" in assetSelection) {
      res.status(400).json({ error: assetSelection.error });
      return;
    }
    const dataset = await readDataset();
    const epochProgress = currentDifficultyEpochProgress(dataset);
    const calculatedAt = policy.now();
    const agentAuth = verifyRequestAgent(req, agentReputation, calculatedAt);
    if (agentAuth.provided && !agentAuth.identity) {
      res.status(401).json({ error: "Invalid NIP-98 authorization" });
      return;
    }
    const quotes = (Object.keys(SUBSCRIPTION_TIERS) as SubscriptionTier[]).map(
      (tier) => pricingEngine.quote(tier, epochProgress, calculatedAt),
    );
    res.setHeader(
      "X-L402-Subscription-Tiers",
      quotes
        .map((quote) => {
          const adjusted = agentReputation.applyPricing(
            quote.priceSats,
            agentAuth.identity,
          );
          return `${quote.tier}=${adjusted.priceSats}`;
        })
        .join(", "),
    );
    res.status(200).json({
      protocol: "L402",
      settlement_asset: assetSelection.asset,
      supported_assets: supportedSettlementAssets(settlementRouter),
      available_assets: availableSettlementAssets(settlementRouter),
      access_tiers: quotes.map((quote) => {
        const adjusted = agentReputation.applyPricing(
          quote.priceSats,
          agentAuth.identity,
        );
        return {
          id: quote.tier,
          duration_days: quote.tier === "1-day" ? 1 : 30,
          price_sats: adjusted.priceSats,
          original_price_sats: quote.priceSats,
          discount_sats: adjusted.discountSats,
          discount_percent: adjusted.discountPercent,
          base_price_sats: quote.basePriceSats,
          max_price_sats: quote.maxPriceSats,
          multiplier: quote.multiplier,
        };
      }),
      agent: agentAuth.identity
        ? {
            pubkey: agentAuth.identity.pubkey,
            tier: agentAuth.identity.tier,
            discount_percent: agentAuth.identity.discountPercent,
            rate_limit_multiplier: agentAuth.identity.rateLimitMultiplier,
          }
        : undefined,
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
        name: "stratigraphy.get",
        parameters: {
          days: {
            type: "integer",
            description:
              "Legacy selector for the number of most recent daily snapshots; cannot be combined with other selectors.",
            example: 10,
            minimum: 1,
            maximum: dataset.length,
            required: false,
          },
          date: {
            type: "string",
            description:
              "Legacy exact dataset date formatted as YYYY-MM-DD in UTC; cannot be combined with other selectors.",
            example: "2026-09-18",
            format: "date",
            required: false,
          },
          blockHeight: {
            type: "integer",
            description:
              "Legacy exact non-negative deterministic daily block-index height; cannot be combined with other selectors.",
            example: 920000,
            minimum: 0,
            required: false,
          },
          metrics: {
            type: "array",
            description:
              "Optional thermodynamic metric projection; omitted metrics are excluded from quantitative_alpha.",
            example: ["target_multiplier"],
            allowedValues: [
              "target_multiplier",
              "difficulty_epoch_progress",
              "thermodynamic_signal",
            ],
            required: false,
          },
          startDate: {
            type: "string",
            description:
              "Inclusive UTC lower date bound formatted as YYYY-MM-DD.",
            example: "2026-09-01",
            format: "date",
            required: false,
          },
          endDate: {
            type: "string",
            description:
              "Inclusive UTC upper date bound formatted as YYYY-MM-DD.",
            example: "2026-09-18",
            format: "date",
            required: false,
          },
          startBlock: {
            type: "integer",
            description:
              "Inclusive non-negative lower bound in the deterministic daily block index.",
            example: 910000,
            minimum: 0,
            required: false,
          },
          endBlock: {
            type: "integer",
            description:
              "Inclusive non-negative upper bound in the deterministic daily block index.",
            example: 920000,
            minimum: 0,
            required: false,
          },
          limit: {
            type: "integer",
            description:
              "Maximum matching snapshots returned; defaults to 10 and cannot exceed 100.",
            example: 10,
            minimum: 1,
            maximum: 100,
            required: false,
          },
        },
      },
      catalog_tool: {
        name: "stratigraphy.list",
        description:
          "Discover available stratigraphy datasets, date ranges, total recorded epochs, block height bounds, and available telemetry metrics without requiring prior knowledge of exact snapshot parameters.",
        catalog: {
          totalSnapshots: dataset.length,
          oldestBlock: 920_000 - (dataset.length - 1) * 144,
          newestBlock: 920_000,
          availableMetrics: [
            "day",
            "title",
            "video_id",
            "transcript_summary",
            "quantitative_alpha.target_multiplier",
            "quantitative_alpha.difficulty_epoch_progress",
            "quantitative_alpha.thermodynamic_signal",
          ],
          dateBounds: {
            startDate: new Date(
              LATEST_DATASET_DATE_MS - (dataset.length - 1) * DAY_MS,
            ).toISOString().slice(0, 10),
            endDate: "2026-09-09",
          },
        },
      },
      proof_status_tool: {
        name: "proof.status",
        description:
          "Query the cryptographic attestation status, verification cache history, and Nostr NIP-78 publication state of a previously submitted zk-SNARK proof digest or snapshot CID.",
        identifiers: ["proofHash", "snapshotDigest"],
        exampleStatus: {
          status: "pending",
          verifiedAt: new Date(calculatedAt).toISOString(),
          attestationCount: 0,
          meshQuorum: false,
        },
      },
      proof_attestations_tool: {
        name: "proof.list",
        description:
          "Browse and discover recent zk-SNARK proof CIDs, NIP-78 attestation records, and indexed verification logs without needing prior knowledge of a proof hash or digest.",
        parameters: {
          limit: {
            type: "integer",
            description: "Maximum number of attestation records to return.",
            example: 10,
            minimum: 1,
            maximum: 100,
            required: false,
          },
          status: {
            type: "string",
            description:
              "Filter attestations by lifecycle verification state.",
            example: "verified",
            allowedValues: ["verified", "cached", "pending", "invalid"],
            required: false,
          },
        },
        exampleResult: {
          attestations: [{
            proofHash:
              "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
            snapshotDigest: "1534979302823651498736582947365829473658294",
            status: "verified",
            submittedAt: new Date(calculatedAt).toISOString(),
            attestationCount: 1,
            meshQuorum: true,
          }],
          total: 1,
        },
      },
      submit_proof_tool: {
        name: "proof.submit",
        description:
          "Submit a new Groth16/Poseidon zk-SNARK proof payload and public signals to the data engine for verification, lifecycle indexing, and Nostr NIP-78 attestation broadcast.",
        requiredInputs: ["proof", "publicSignals"],
        optionalInputs: ["snapshotDigest"],
        exampleResult: {
          proofHash:
            "0x1a2b3c4d5e6f789001234567890abcdef1234567890abcdef1234567890abcd",
          status: "verified",
          submittedAt: new Date(calculatedAt).toISOString(),
          attestationStatus: "broadcast_confirmed",
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
      const serializedBody = JSON.stringify(req.body);
      const agentPayload =
        (req as Request & { rawBody?: Buffer }).rawBody ??
        (serializedBody === undefined
          ? undefined
          : Buffer.from(serializedBody));
      const agentAuth = verifyRequestAgent(
        req,
        agentReputation,
        policy.now(),
        agentPayload,
      );
      if (agentAuth.provided && !agentAuth.identity) {
        res.status(401).json({ error: "Invalid NIP-98 authorization" });
        return;
      }
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
        agentAuth.identity ?? null,
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
        asset: parent.paymentAsset,
        expectedProvider: parent.paymentProvider,
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
        agentAuth.identity ?? null,
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
      let eventQueue: Promise<void> = Promise.resolve();
      let activeStreamEntitlement: string | undefined;
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
        if (activeStreamEntitlement) {
          activeStreamEntitlements.delete(activeStreamEntitlement);
          activeStreamEntitlement = undefined;
        }
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
      const assetSelection = requestSettlementAsset(req);
      if ("error" in assetSelection) {
        res.status(400).json({ error: assetSelection.error });
        return;
      }
      if (!settlementRouter.isConfigured()) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      const agentAuth = verifyRequestAgent(
        req,
        agentReputation,
        policy.now(),
      );
      if (agentAuth.provided && !agentAuth.identity) {
        res.status(401).json({ error: "Invalid NIP-98 authorization" });
        return;
      }
      const challengeCaller = agentAuth.identity
        ? `nostr:${agentAuth.identity.pubkey}`
        : caller;
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
            agentAuth.identity ?? null,
          );
        const structurallyValidPass = secret
          ? verifySubscriptionMacaroon(
            authorization.macaroon,
            secret,
            Math.floor(policy.now() / 1000),
          )
          : null;
        if (structurallyValidPass?.agentPubkey && !pass) {
          res.status(401).json({
            error: "Agent identity does not match macaroon caveat",
          });
          return;
        }
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
              asset: pass.paymentAsset,
              expectedProvider: pass.paymentProvider,
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
            await recordL402Revenue({
              req,
              paymentHash: pass.paymentHash,
              preimage: authorization.preimage,
              amountMsats: pass.amountMsats ?? definition.amountMsats,
              settledAt: verification.settledAt,
              clientIdentifier: challengeCaller,
            });
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
        if (!settlementRouter.isConfigured(assetSelection.asset)) {
          res.status(500).json({
            error: "Requested settlement asset is not configured",
          });
          return;
        }
        await sendPaymentChallenge(
          req,
          res,
          settlementRouter,
          challengeStore,
          policy,
          challengeCaller,
          `stream:${selectedRange.key}`,
          selectedRange.amountMsats,
          selectedRange.description,
          pricingEngine,
          currentDifficultyEpochProgress(dataset),
          agentReputation,
          assetSelection.asset,
          agentAuth.identity,
        );
        return;
      }

      if (disconnected || res.destroyed) return;
      if (activeStreamEntitlements.has(paymentHash)) {
        res.status(429).json({
          error: "A stream is already active for this paid entitlement",
        });
        return;
      }
      activeStreamEntitlement = paymentHash;
      activeStreamEntitlements.add(paymentHash);
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const writeEvent = async (
        event: "telemetry",
        data: Record<string, unknown>,
      ): Promise<void> => {
        if (
          disconnected ||
          waitingForDrain ||
          res.destroyed ||
          res.writableEnded
        ) {
          return;
        }
        let attested;
        try {
          attested = attest(data, Math.floor(policy.now() / 1_000));
        } catch (error) {
          req.log.error({ err: error }, "Nostr SSE attestation failed");
          close();
          if (!res.writableEnded) res.end();
          return;
        }
        let zkProof;
        try {
          const telemetry = data as {
            block?: { height?: number | null };
            thermodynamic?: { target_multiplier?: number };
          };
          const height = telemetry.block?.height;
          zkProof = await generateZkProof({
            snapshot: attested,
            blockHeight:
              typeof height === "number" && Number.isSafeInteger(height)
                ? height
                : 0,
            timestamp:
              typeof data.observed_at === "string" &&
              Number.isSafeInteger(Date.parse(data.observed_at))
                ? Date.parse(data.observed_at)
                : policy.now(),
            valuationMultiplier:
              telemetry.thermodynamic?.target_multiplier ?? 0,
            lane: "stream",
          });
        } catch (error) {
          req.log.error({ err: error }, "zk SSE proof generation failed");
          close();
          if (!res.writableEnded) res.end();
          return;
        }
        let meshConsensus;
        try {
          meshConsensus = await mesh.createConsensus(attested);
        } catch (error) {
          req.log.error({ err: error }, "mesh SSE consensus failed");
          close();
          if (!res.writableEnded) res.end();
          return;
        }
        if (
          disconnected ||
          waitingForDrain ||
          res.destroyed ||
          res.writableEnded
        ) {
          return;
        }
        if (
          !res.write(
            `event: ${event}\ndata: ${JSON.stringify({ data: attested, zkProof, meshConsensus })}\n\n`,
          )
        ) {
          waitingForDrain = true;
          res.once("drain", drained);
        }
      };
      const enqueueEvent = (
        event: "telemetry",
        data: Record<string, unknown>,
      ) => {
        eventQueue = eventQueue
          .then(() => writeEvent(event, data))
          .catch((error) => {
            req.log.error({ err: error }, "zk SSE event queue failed");
            close();
            if (!res.writableEnded) res.end();
          });
      };
      unsubscribe = telemetryHub.subscribe((telemetry) => {
        enqueueEvent("telemetry", telemetry);
      });
      if (disconnected) {
        close();
        return;
      }
      heartbeat = heartbeatScheduler.setInterval(() => {
        if (
          disconnected ||
          waitingForDrain ||
          res.destroyed ||
          res.writableEnded
        ) {
          return;
        }
        if (!res.write(": ping\n\n")) {
          waitingForDrain = true;
          res.once("drain", drained);
        }
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
      const assetSelection = requestSettlementAsset(req);
      if ("error" in assetSelection) {
        res.status(400).json({ error: assetSelection.error });
        return;
      }
      if (!settlementRouter.isConfigured()) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      const agentAuth = verifyRequestAgent(
        req,
        agentReputation,
        policy.now(),
      );
      if (agentAuth.provided && !agentAuth.identity) {
        res.status(401).json({ error: "Invalid NIP-98 authorization" });
        return;
      }
      const challengeCaller = agentAuth.identity
        ? `nostr:${agentAuth.identity.pubkey}`
        : caller;
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
              agentAuth.identity ?? null,
            );
          const structurallyValidPass = secret
            ? verifySubscriptionMacaroon(
              authorization.macaroon,
              secret,
              Math.floor(policy.now() / 1000),
            )
            : null;
          if (structurallyValidPass?.agentPubkey && !pass) {
            res.status(401).json({
              error: "Agent identity does not match macaroon caveat",
            });
            return;
          }
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
              asset: pass.paymentAsset,
              expectedProvider: pass.paymentProvider,
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
              await recordL402Revenue({
                req,
                paymentHash: pass.paymentHash,
                preimage: authorization.preimage,
                amountMsats: pass.amountMsats ?? definition.amountMsats,
                settledAt: verification.settledAt,
                clientIdentifier: challengeCaller,
              });
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
              await sendPaidDataset(
                res,
                selectedRange.records,
                pass.paymentHash,
                policy.now(),
                attestDataset,
                mesh,
              );
              return;
            }
          }
        }
        if (authorization.kind === "legacy") {
        const issuedChallenge = await challengeStore.findByPaymentHash(
          challengeCaller,
          authorization.paymentHash,
        );
        if (
          !issuedChallenge?.provider ||
          issuedChallenge.provider === "legacy-unbound"
        ) {
          res.status(401).json({ error: "Invalid payment challenge" });
          return;
        }
        if (issuedChallenge.asset !== assetSelection.asset) {
          res.status(401).json({ error: "Settlement asset does not match challenge" });
          return;
        }
        const verification = await settlementRouter.verifyPayment({
          paymentHash: authorization.paymentHash,
          preimage: authorization.preimage,
          expectedAmountMsats: selectedRange.amountMsats,
          expectedDescription: selectedRange.description,
          asset: assetSelection.asset,
          expectedProvider: issuedChallenge.provider,
        });
        if (verification === "unavailable") {
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (typeof verification === "object") {
          await recordL402Revenue({
            req,
            paymentHash: authorization.paymentHash,
            preimage: authorization.preimage,
            amountMsats: selectedRange.amountMsats,
            settledAt: verification.settledAt,
            clientIdentifier: challengeCaller,
          });
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
          await sendPaidDataset(
            res,
            selectedRange.records,
            authorization.paymentHash,
            policy.now(),
            attestDataset,
            mesh,
          );
          return;
        }
        }
      }

      if (!settlementRouter.isConfigured(assetSelection.asset)) {
        res.status(500).json({
          error: "Requested settlement asset is not configured",
        });
        return;
      }
      await sendPaymentChallenge(
        req,
        res,
        settlementRouter,
        challengeStore,
        policy,
          challengeCaller,
        selectedRange.key,
        selectedRange.amountMsats,
        selectedRange.description,
        pricingEngine,
        currentDifficultyEpochProgress(dataset),
        agentReputation,
        assetSelection.asset,
        agentAuth.identity,
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
