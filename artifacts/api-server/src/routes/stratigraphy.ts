import { NWCClient } from "@getalby/sdk";
import { GetPaidStratigraphyResponse } from "@workspace/api-zod";
import {
  type Express,
  type Request,
  type Response,
} from "express";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../openapi";

const ACCESS_PRICE_MSATS = 21_000;
const INVOICE_DESCRIPTION = "Bitcoin Stratigraphy 422-day dataset access";
const CHALLENGE_REUSE_MS = 5 * 60 * 1000;
const INVOICE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_INVOICES_PER_WINDOW = 3;
const MAX_CHALLENGE_CALLERS = 10_000;
const datasetPath = fileURLToPath(
  new URL("../data/stratigraphy.json", import.meta.url),
);
const silentNwcLogger = { debug: (..._args: unknown[]) => undefined };

async function readDataset() {
  const raw = await readFile(datasetPath, "utf8");
  return GetPaidStratigraphyResponse.parse(JSON.parse(raw));
}

type NwcClient = Pick<NWCClient, "lookupInvoice" | "makeInvoice" | "close">;
type NwcClientFactory = (nwcUri: string) => NwcClient;
type Challenge = { invoice: string; paymentHash: string };
type CallerChallenge = {
  challenge?: Challenge;
  challengeExpiresAt: number;
  invoiceAttemptedAt: number[];
  pending?: Promise<Challenge>;
};
type ChallengePolicy = {
  now: () => number;
  reuseMs: number;
  limitWindowMs: number;
  maxInvoicesPerWindow: number;
  maxCallers: number;
};

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
      transaction.amount >= ACCESS_PRICE_MSATS &&
      transaction.description === INVOICE_DESCRIPTION &&
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
) {
  const client = clientFactory(nwcUri);
  try {
    const transaction = await client.makeInvoice({
      amount: ACCESS_PRICE_MSATS,
      description: INVOICE_DESCRIPTION,
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
  challenges: Map<string, CallerChallenge>,
  policy: ChallengePolicy,
) {
  const now = policy.now();
  const caller = callerKey(req);
  let state = challenges.get(caller);

  if (!state) {
    if (challenges.size >= policy.maxCallers) {
      for (const [key, candidate] of challenges) {
        const newestAttemptAt = candidate.invoiceAttemptedAt.at(-1) ?? 0;
        const inactiveAt = Math.max(
          candidate.challengeExpiresAt,
          newestAttemptAt + policy.limitWindowMs,
        );
        if (!candidate.pending && inactiveAt <= now) {
          challenges.delete(key);
        }
      }
    }
    if (challenges.size >= policy.maxCallers) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({
        error: "Payment challenge limit reached",
        code: "payment_challenge_rate_limited",
        retry_after: 60,
      });
      return;
    }
    state = {
      challengeExpiresAt: 0,
      invoiceAttemptedAt: [],
    };
    challenges.set(caller, state);
  }

  state.invoiceAttemptedAt = state.invoiceAttemptedAt.filter(
    (createdAt) => now - createdAt < policy.limitWindowMs,
  );

  try {
    let challenge = state.challenge;
    if (!challenge || state.challengeExpiresAt <= now) {
      if (state.pending) {
        challenge = await state.pending;
      } else {
        if (state.invoiceAttemptedAt.length >= policy.maxInvoicesPerWindow) {
          const retryAfter = Math.max(
            1,
            Math.ceil(
              (policy.limitWindowMs -
                (now - state.invoiceAttemptedAt[0])) /
                1000,
            ),
          );
          res.setHeader("Retry-After", String(retryAfter));
          res.status(429).json({
            error: "Too many payment invoices requested",
            code: "payment_challenge_rate_limited",
            retry_after: retryAfter,
          });
          return;
        }

        state.invoiceAttemptedAt.push(now);
        const pending = createInvoice(nwcUri, clientFactory).then((created) => {
          const createdAt = policy.now();
          state.challenge = created;
          state.challengeExpiresAt = createdAt + policy.reuseMs;
          return created;
        });
        state.pending = pending;
        try {
          challenge = await pending;
        } finally {
          if (state.pending === pending) {
            state.pending = undefined;
          }
        }
      }
    }

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
    req.log.error({ err: error }, "CoinOS NWC invoice creation failed");
    res.status(502).json({ error: "Unable to create payment invoice" });
  }
}

export function registerStratigraphyRoutes(
  app: Express,
  clientFactory: NwcClientFactory = createNwcClient,
  policy: ChallengePolicy = defaultChallengePolicy,
): void {
  const challenges = new Map<string, CallerChallenge>();

  app.get("/api", (_req, res): void => {
    res.status(200).json({
      status: "online",
      service: "Bitcoin Stratigraphy API",
    });
  });

  app.get("/api/v1/stratigraphy/sample", async (_req, res): Promise<void> => {
    const data = await readDataset();
    res.status(200).json(data.slice(-5));
  });

  app.get(
    "/api/v1/stratigraphy",
    async (req: Request, res: Response): Promise<void> => {
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
        );
        if (verification === "unavailable") {
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (verification === "valid") {
          const callerState = challenges.get(callerKey(req));
          if (
            callerState?.challenge?.paymentHash === authorization.paymentHash
          ) {
            challenges.delete(callerKey(req));
          }
          const data = await readDataset();
          res.status(200).json(data);
          return;
        }
      }

      await sendPaymentChallenge(
        req,
        res,
        nwcUri,
        clientFactory,
        challenges,
        policy,
      );
    },
  );

  app.get("/openapi.json", (_req, res): void => {
    res.status(200).json(openApiDocument);
  });

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
