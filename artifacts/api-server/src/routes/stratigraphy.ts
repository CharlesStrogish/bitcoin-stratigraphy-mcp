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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createMemoryPaymentChallengeStore,
  type PaymentChallengeStore,
} from "../lib/payment-challenge-store";

const MIN_INVOICE_SATS = 5;
const LATEST_DATASET_DATE_MS = Date.UTC(2026, 8, 9);
const DAY_MS = 24 * 60 * 60 * 1000;
const CHALLENGE_REUSE_MS = 5 * 60 * 1000;
const INVOICE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_INVOICES_PER_WINDOW = 3;
const MAX_CHALLENGE_CALLERS = 10_000;
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

  let records = dataset;
  if (daysValue !== undefined) {
    if (!/^[1-9]\d*$/.test(daysValue)) {
      return "days must be an integer between 1 and 422";
    }
    const days = Number(daysValue);
    if (days > dataset.length) {
      return `days must be an integer between 1 and ${dataset.length}`;
    }
    records = dataset.slice(-days);
  } else if (fromValue !== undefined) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromValue);
    if (!match) return "from must use YYYY-MM-DD";
    const fromMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const normalized = new Date(fromMs).toISOString().slice(0, 10);
    if (normalized !== fromValue) return "from must be a valid calendar date";
    const firstDateMs = LATEST_DATASET_DATE_MS - (dataset.length - 1) * DAY_MS;
    if (fromMs < firstDateMs || fromMs > LATEST_DATASET_DATE_MS) {
      return `from must be between ${new Date(firstDateMs).toISOString().slice(0, 10)} and 2026-09-09`;
    }
    records = dataset.slice((fromMs - firstDateMs) / DAY_MS);
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

  const match = /^L402\s+([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec(
    value.trim(),
  );
  if (!match) return null;

  return {
    paymentHash: match[1].toLowerCase(),
    preimage: match[2].toLowerCase(),
  };
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
    return (
      transaction.type === "incoming" &&
      transaction.state === "settled" &&
      transaction.amount === expectedAmountMsats &&
      transaction.description === expectedDescription &&
      transaction.payment_hash.toLowerCase() === paymentHash &&
      (!transaction.preimage ||
        transaction.preimage.toLowerCase() === preimage)
    )
      ? "valid"
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
    const result = await challengeStore.getOrCreate(caller, rangeKey, policy, async () => {
      try {
        return await createInvoice(
          nwcUri,
          clientFactory,
          amountMsats,
          description,
        );
      } catch (error) {
        throw new InvoiceCreationError(error);
      }
    });
    if (result.kind === "limited") {
      res.setHeader("Retry-After", String(result.retryAfter));
      res.status(429).json({
        error: "Too many payment invoices requested",
        code: "payment_challenge_rate_limited",
        retry_after: result.retryAfter,
      });
      return;
    }
    const challenge = result.challenge;

    res.setHeader(
      "WWW-Authenticate",
      `L402 macaroon="${challenge.paymentHash}", invoice="${challenge.invoice}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(402).json({
      invoice: challenge.invoice,
      payment_hash: challenge.paymentHash,
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
        if (verification === "valid") {
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
          res.status(200).json(selectedRange.records);
          return;
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

The full 422-record dataset costs 21 satoshis. An unauthenticated request returns
HTTP 402 with a BOLT11 invoice and a WWW-Authenticate L402 challenge. After
payment, retry with:

Authorization: L402 <payment_hash>:<preimage>
`);
  });
}
