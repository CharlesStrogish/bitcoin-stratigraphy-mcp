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
  amountSats: number;
  description: string;
  settlementRouter: SettlementRouter;
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
  const match = /^L402\s+([^:\s]+):([0-9a-fA-F]{64})$/.exec(
    value?.trim() ?? "",
  );
  return match
    ? { macaroon: match[1]!, preimage: match[2]!.toLowerCase() }
    : null;
}

export function createL402Middleware(
  options: L402MiddlewareOptions,
): RequestHandler {
  if (!Number.isSafeInteger(options.amountSats) || options.amountSats <= 0) {
    throw new RangeError("L402 amountSats must be a positive integer");
  }
  const amountMsats = options.amountSats * 1_000;
  const invoiceExpirySeconds = options.invoiceExpirySeconds ?? 3_600;
  const now = options.now ?? Date.now;
  const usageStore = options.usageStore ?? createMemoryMacaroonUsageStore();
  const maxChallengesPerMinute = options.maxChallengesPerMinute ?? 10;
  const challengeWindows = new Map<string, { startedAt: number; count: number }>();

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
      const invoice = await options.settlementRouter.createInvoice({
        amountMsats,
        description: options.description,
        expirySeconds: invoiceExpirySeconds,
        asset: "btc-lightning",
      });
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
        `allowed_path=${req.path}`,
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
        amount_sats: options.amountSats,
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
      const preimageHash = createHash("sha256")
        .update(Buffer.from(authorization.preimage, "hex"))
        .digest("hex");
      if (
        pass &&
        pass.paymentHash === preimageHash &&
        pass.amountMsats === amountMsats &&
        pass.paymentAsset === "btc-lightning" &&
        pass.paymentProvider &&
        !pass.allowedPaths.some((path) => path !== req.path)
      ) {
        const verification = await options.settlementRouter.verifyPayment({
          paymentHash: pass.paymentHash,
          preimage: authorization.preimage,
          expectedAmountMsats: amountMsats,
          expectedDescription: options.description,
          expectedProvider: pass.paymentProvider,
          asset: "btc-lightning",
        });
        if (verification === "unavailable") {
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (typeof verification === "object") {
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
                satsReceived: options.amountSats,
                paymentHash: pass.paymentHash,
                preimage: authorization.preimage,
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
          if (
            pass.maxRequests !== undefined &&
            !(await usageStore.consume(pass.requestLimits, pass.validUntil))
          ) {
            res.status(429).json({ error: "L402 macaroon has already been used" });
            return;
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