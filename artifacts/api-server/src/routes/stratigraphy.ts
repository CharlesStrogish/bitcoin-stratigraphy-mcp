import { NWCClient } from "@getalby/sdk";
import {
  GetPaidStratigraphyResponse,
  ReadinessCheckResponse,
} from "@workspace/api-zod";
import {
  type Express,
  type Request,
  type Response,
} from "express";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createMemoryPaymentChallengeStore,
  type PaymentChallengeStore,
} from "../lib/payment-challenge-store";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  SUBSCRIPTION_TIERS,
  type SubscriptionTier,
  verifySubscriptionMacaroon,
} from "../lib/subscription-pass";
import {
  createMemoryMacaroonUsageStore,
  type MacaroonUsageStore,
} from "../lib/macaroon-usage-store";

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
const silentNwcLogger = { debug: (..._args: unknown[]) => undefined };

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

type NwcClient = Pick<NWCClient, "lookupInvoice" | "makeInvoice" | "close">;
type NwcClientFactory = (nwcUri: string) => NwcClient;
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

const createNwcClient: NwcClientFactory = (nwcUri) => {
  return new NWCClient({
    nostrWalletConnectUrl: nwcUri,
    logger: silentNwcLogger,
  });
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

async function verifyPayment(
  nwcUri: string,
  paymentHash: string,
  preimage: string,
  clientFactory: NwcClientFactory,
  expectedAmountMsats: number,
  expectedDescription: string,
) {
  const computedHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  if (computedHash !== paymentHash) return "invalid";

  const client = clientFactory(nwcUri);
  try {
    const transaction = await client.lookupInvoice({
      payment_hash: paymentHash,
    });
    const valid =
      transaction.type === "incoming" &&
      transaction.state === "settled" &&
      transaction.amount === expectedAmountMsats &&
      transaction.description === expectedDescription &&
      transaction.payment_hash.toLowerCase() === paymentHash &&
      (!transaction.preimage ||
        transaction.preimage.toLowerCase() === preimage);
    return valid
      ? {
          settledAt:
            typeof transaction.settled_at === "number"
              ? transaction.settled_at
              : 0,
        }
      : "invalid";
  } catch {
    return "unavailable";
  } finally {
    client.close();
  }
}

async function createInvoice(
  nwcUri: string,
  clientFactory: NwcClientFactory,
  amountMsats: number,
  description: string,
) {
  const client = clientFactory(nwcUri);
  try {
    const transaction = await client.makeInvoice({
      amount: amountMsats,
      description,
      expiry: 3600,
    });

    if (
      !transaction.invoice.startsWith("ln") ||
      !/^[0-9a-fA-F]{64}$/.test(transaction.payment_hash)
    ) {
      throw new Error("CoinOS returned an incomplete NWC invoice");
    }

    return {
      invoice: transaction.invoice,
      paymentHash: transaction.payment_hash.toLowerCase(),
      issuedAt: Date.now(),
    };
  } finally {
    client.close();
  }
}

async function sendPaymentChallenge(
  req: Request,
  res: Response,
  nwcUri: string,
  clientFactory: NwcClientFactory,
  challengeStore: PaymentChallengeStore,
  policy: ChallengePolicy,
  caller: string,
  rangeKey: string,
  amountMsats: number,
  description: string,
) {
  try {
    const getChallenge = async (
      scope: string,
      challengeAmountMsats: number,
      challengeDescription: string,
    ) => {
      return challengeStore.getOrCreate(caller, scope, policy, async () => {
        try {
          const challenge = await createInvoice(
            nwcUri,
            clientFactory,
            challengeAmountMsats,
            challengeDescription,
          );
          return { ...challenge, issuedAt: policy.now() };
        } catch (error) {
          throw new InvoiceCreationError(error);
        }
      });
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
          const result = await getChallenge(
            `subscription:${tier}`,
            definition.amountMsats,
            definition.description,
          );
          return { tier, definition, result };
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
    const passes = passResults.map(({ tier, definition, result }) => {
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
        }),
        valid_until: validUntil,
      };
    });

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
): void {
  app.get("/api", (_req, res): void => {
    res.status(200).json({
      status: "online",
      service: "Bitcoin Stratigraphy API",
    });
  });

  app.get("/api/readyz", async (req, res): Promise<void> => {
    const walletConfiguration =
      typeof process.env.NWC_URI === "string" &&
      process.env.NWC_URI.trim().length > 0
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
    res.status(200).json({
      protocol: "L402",
      access_tiers: [
        { id: "1-day", duration_days: 1, price_sats: 5 },
        { id: "30-day", duration_days: 30, price_sats: 100 },
      ],
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
      const parent = verifySubscriptionMacaroon(
        parentMacaroon,
        secret,
        Math.floor(policy.now() / 1000),
      );
      if (!parent) {
        res.status(401).json({ error: "Invalid parent macaroon" });
        return;
      }
      const nwcUri = process.env.NWC_URI;
      if (!nwcUri) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }
      const definition = SUBSCRIPTION_TIERS[parent.tier];
      const verification = await verifyPayment(
        nwcUri,
        parent.paymentHash,
        authorization.preimage,
        clientFactory,
        definition.amountMsats,
        definition.description,
      );
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
        "1-day=5, 30-day=100",
      );
      res.status(200).end();
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
      const nwcUri = process.env.NWC_URI;
      if (!nwcUri) {
        res.status(500).json({ error: "NWC_URI is not configured" });
        return;
      }

      const authorization = parseL402Authorization(
        req.header("Authorization"),
      );
      if (authorization) {
        if (authorization.kind === "subscription") {
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
            const verification = await verifyPayment(
              nwcUri,
              pass.paymentHash,
              authorization.preimage,
              clientFactory,
              definition.amountMsats,
              definition.description,
            );
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
        const verification = await verifyPayment(
          nwcUri,
          authorization.paymentHash,
          authorization.preimage,
          clientFactory,
          selectedRange.amountMsats,
          selectedRange.description,
        );
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
        nwcUri,
        clientFactory,
        challengeStore,
        policy,
        caller,
        selectedRange.key,
        selectedRange.amountMsats,
        selectedRange.description,
      );
    },
  );

  app.get("/llms.txt", (_req, res): void => {
    res.type("text/plain").send(`# Bitcoin Stratigraphy API

Machine-readable OpenAPI: GET /openapi.json
Free sample: GET /api/v1/stratigraphy/sample
Paid dataset: GET /api/v1/stratigraphy

Legacy single-query access costs one satoshi per selected day with a five-satoshi
minimum. The same HTTP 402 response also offers a 1-Day Micro-Pass for 5 sats and
a 30-Day Pass for 100 sats. Passes allow unlimited queries until their signed
valid_until caveat and settlement-based entitlement expiry. After payment, retry
with:

Authorization: L402 <payment_hash>:<preimage>

For a pass, use:

Authorization: L402 <signed_macaroon>:<preimage>
`);
  });
}
