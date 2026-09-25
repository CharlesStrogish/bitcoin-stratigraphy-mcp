import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../lib/subscription-pass";
import {
  createMemoryMacaroonUsageStore,
  type MacaroonUsageStore,
} from "../lib/macaroon-usage-store";
import type { SettlementRouter } from "../services/settlement";
import type {
  RevenueLedger,
  RevenueRequestKind,
} from "../services/ledger";
import {
  paymentReference,
  recordRevenueWithRetry,
} from "../services/ledger";

export type L402Authorization = {
  macaroon: string;
  preimage: string;
};

export type L402MiddlewareOptions = {
  amountSats: number | (() => number);
  description: string;
  settlementRouter: SettlementRouter;
  scopePath?: string;
  sessionSecret?: string;
  invoiceExpirySeconds?: number;
  now?: () => number;
  usageStore?: MacaroonUsageStore;
  maxChallengesPerMinute?: number;
  ledger?: RevenueLedger;
  requestKind?: RevenueRequestKind;
};

export function parseL402Header(
  value: string | undefined,
): L402Authorization | null {
  const match = /^L402\s+([^:\s]+):([0-9a-fA-F]{64}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/.exec(
    value?.trim() ?? "",
  );
  return match
    ? { macaroon: match[1]!, preimage: match[2]!.toLowerCase() }
    : null;
}

export function createL402Middleware(
  options: L402MiddlewareOptions,
): RequestHandler {
  if (options.scopePath && !/^\/[^\s]*$/.test(options.scopePath)) {
    throw new RangeError("L402 scopePath must be an absolute path");
  }
  if (
    !Number.isSafeInteger(options.invoiceExpirySeconds ?? 3_600) ||
    (options.invoiceExpirySeconds ?? 3_600) <= 0
  ) {
    throw new RangeError("L402 invoiceExpirySeconds must be a positive integer");
  }
  if (
    !Number.isSafeInteger(options.maxChallengesPerMinute ?? 10) ||
    (options.maxChallengesPerMinute ?? 10) <= 0
  ) {
    throw new RangeError("L402 maxChallengesPerMinute must be a positive integer");
  }
  const resolveAmountSats = () => {
    const amount =
      typeof options.amountSats === "function"
        ? options.amountSats()
        : options.amountSats;
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    ) {
      throw new RangeError("L402 amountSats must be a positive integer");
    }
    return amount;
  };
  if (typeof options.amountSats === "number") resolveAmountSats();
  const invoiceExpirySeconds = options.invoiceExpirySeconds ?? 3_600;
  const now = options.now ?? Date.now;
  const usageStore = options.usageStore ?? createMemoryMacaroonUsageStore(now);
  const maxChallengesPerMinute = options.maxChallengesPerMinute ?? 10;
  const challengeWindows = new Map<string, { startedAt: number; count: number }>();
  const maxChallengeCallers = 10_000;
  let challengeWindowsCleanedAt = 0;

  const sendChallenge: RequestHandler = async (req, res) => {
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    if (!secret) {
      res.status(500).json({ error: "SESSION_SECRET is not configured" });
      return;
    }
    if (!options.settlementRouter.isConfigured("btc-lightning")) {
      res.status(500).json({ error: "Lightning settlement is not configured" });
      return;
    }
    const caller = req.ip || req.socket.remoteAddress || "unknown";
    const currentTime = now();
    if (
      currentTime - challengeWindowsCleanedAt >= 60_000 ||
      challengeWindows.size >= maxChallengeCallers
    ) {
      for (const [key, candidate] of challengeWindows) {
        if (currentTime - candidate.startedAt >= 60_000) {
          challengeWindows.delete(key);
        }
      }
      challengeWindowsCleanedAt = currentTime;
    }
    if (!challengeWindows.has(caller) && challengeWindows.size >= maxChallengeCallers) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many payment challenges requested" });
      return;
    }
    const currentWindow = challengeWindows.get(caller);
    const window =
      !currentWindow || currentTime - currentWindow.startedAt >= 60_000
        ? { startedAt: currentTime, count: 0 }
        : currentWindow;
    window.count += 1;
    challengeWindows.set(caller, window);
    if (window.count > maxChallengesPerMinute) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((60_000 - (currentTime - window.startedAt)) / 1_000))),
      );
      res.status(429).json({ error: "Too many payment challenges requested" });
      return;
    }
    try {
      const amountSats = resolveAmountSats();
      const amountMsats = amountSats * 1_000;
      const invoice = await options.settlementRouter.createInvoice({
        amountMsats,
        description: options.description,
        expirySeconds: invoiceExpirySeconds,
        asset: "btc-lightning",
      });
      if (
        typeof invoice.invoice !== "string" ||
        !invoice.invoice.startsWith("ln") ||
        !/^[0-9a-f]{64}$/.test(invoice.paymentHash) ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(invoice.provider)
      ) {
        throw new Error("Settlement provider returned an invalid invoice");
      }
      const rootMacaroon = createSubscriptionMacaroon({
        secret,
        paymentHash: invoice.paymentHash,
        tier: "1-day",
        validUntil: Math.floor(now() / 1_000) + invoiceExpirySeconds,
        amountMsats,
        paymentAsset: "btc-lightning",
        paymentProvider: invoice.provider,
      });
      const macaroon = attenuateSubscriptionMacaroon(rootMacaroon, [
        `allowed_path=${options.scopePath ?? req.path}`,
        "max_requests=1",
      ]);
      if (!macaroon) throw new Error("Unable to attenuate L402 macaroon");
      res.setHeader(
        "WWW-Authenticate",
        `L402 macaroon="${macaroon}", invoice="${invoice.invoice}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(402).json({
        error: "Payment required",
        macaroon,
        invoice: invoice.invoice,
        payment_hash: invoice.paymentHash,
        amount_sats: amountSats,
      });
    } catch (error) {
      req.log?.error({ err: error }, "L402 invoice creation failed");
      res.status(502).json({ error: "Unable to create payment invoice" });
    }
  };

  return async (req, res, next) => {
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    const authorization = parseL402Header(req.header("Authorization"));
    if (secret && authorization) {
      const pass = verifySubscriptionMacaroon(
        authorization.macaroon,
        secret,
        Math.floor(now() / 1_000),
      );
      const preimageHash = /^[0-9a-f]{64}$/.test(authorization.preimage)
        ? createHash("sha256")
          .update(Buffer.from(authorization.preimage, "hex"))
          .digest("hex")
        : null;
      if (
        pass &&
        (pass.paymentHash === preimageHash ||
          (pass.paymentProvider === "coinos" && preimageHash === null)) &&
        pass.amountMsats !== undefined &&
        pass.amountMsats > 0 &&
        (typeof options.amountSats !== "number" ||
          pass.amountMsats === options.amountSats * 1_000) &&
        pass.paymentAsset === "btc-lightning" &&
        pass.paymentProvider &&
        pass.allowedPaths.length > 0 &&
        pass.allowedPaths.every((path) => path === (options.scopePath ?? req.path))
      ) {
        let verification;
        try {
          verification = await options.settlementRouter.verifyPayment({
            paymentHash: pass.paymentHash,
            preimage: authorization.preimage,
            expectedAmountMsats: pass.amountMsats,
            expectedDescription: options.description,
            expectedProvider: pass.paymentProvider,
            asset: "btc-lightning",
          });
        } catch (error) {
          req.log?.error({ err: error }, "L402 payment verification failed");
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (verification === "unavailable") {
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (typeof verification === "object") {
          if (
            pass.maxRequests !== undefined &&
            !(await usageStore.consume(pass.requestLimits, pass.validUntil))
          ) {
            res.status(429).json({ error: "L402 macaroon has already been used" });
            return;
          }
          if (options.ledger) {
            try {
              await recordRevenueWithRetry(options.ledger, {
                id: randomUUID(),
                timestamp: new Date(
                  verification.settledAt < 10_000_000_000
                    ? verification.settledAt * 1_000
                    : verification.settledAt,
                ).toISOString(),
                channel: "L402",
                requestKind: options.requestKind ?? "stratigraphy",
                satsReceived: Math.ceil(pass.amountMsats / 1_000),
                paymentHash: pass.paymentHash,
                ...(/^[0-9a-f]{64}$/.test(authorization.preimage)
                  ? { preimage: authorization.preimage }
                  : { coinosPaymentId: authorization.preimage }),
                clientIdentifier:
                  req.ip || req.socket.remoteAddress || "unknown",
              });
            } catch (error) {
              req.log?.error(
                {
                  err: error,
                  paymentReference: paymentReference(pass.paymentHash),
                },
                "L402 settlement ledger failed",
              );
            }
          }
          res.locals.l402 = {
            paymentHash: pass.paymentHash,
            settledAt: verification.settledAt,
            provider: verification.provider,
          };
          next();
          return;
        }
      }
    }
    await sendChallenge(req, res, next);
  };
}