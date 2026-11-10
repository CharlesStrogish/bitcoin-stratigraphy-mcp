// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { randomBytes } from "node:crypto";
import express, {
  type Express,
  type Request,
  type RequestHandler,
} from "express";
import Stripe from "stripe";
import {
  CreateFiatMintCheckoutBody,
  CreateFiatMintCheckoutResponse,
  GetFiatMintStatusResponse,
  ClaimFiatMintMacaroonResponse,
} from "@workspace/api-zod";
import type { FiatMint } from "../services/fiatMint";

const COOKIE = "__Secure-fiat-mint-owner";
function owner(req: Request) {
  const value = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

export function registerFiatWebhook(
  app: Express,
  processWebhook: (body: Buffer, signature: string) => Promise<void>,
) {
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res): Promise<void> => {
      res.set("Cache-Control", "no-store");
      const signature = req.get("stripe-signature");
      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "Raw signed webhook required" });
        return;
      }
      try {
        await processWebhook(req.body, signature);
        res.json({ received: true });
      } catch (error) {
        // Return a retriable code on configuration/DB failures. Never echo sensitive SDK errors.
        res
          .status(
            error instanceof Stripe.errors.StripeSignatureVerificationError
              ? 400
              : 503,
          )
          .json({
            error:
              "Webhook not accepted; verify signature and server configuration",
          });
      }
    },
  );
}

export function registerFiatMintRoutes(
  app: Express,
  mint: FiatMint,
  origin: () => string,
) {
  const guard: RequestHandler = (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      if (
        req.get("origin") !== origin() ||
        req.get("sec-fetch-site") === "cross-site"
      ) {
        res.status(403).json({ error: "Same-origin checkout required" });
        return;
      }
    } catch {
      res.status(503).json({ error: "Stripe Checkout is not configured" });
      return;
    }
    next();
  };
  app.post("/api/fiat-mint", guard, async (req, res): Promise<void> => {
    if (!CreateFiatMintCheckoutBody.strict().safeParse(req.body).success) {
      res.status(400).json({ error: "Checkout requires an empty JSON object" });
      return;
    }
    const token = owner(req) ?? randomBytes(32).toString("hex");
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/fiat-mint",
      maxAge: 30 * 86400_000,
    });
    try {
      res.json(
        CreateFiatMintCheckoutResponse.parse({
          url: await mint.checkout(token),
        }),
      );
    } catch {
      res.status(503).json({
        error:
          "Checkout unavailable. Recover an existing purchase before buying again.",
      });
    }
  });
  app.post("/api/fiat-mint/status", guard, async (req, res): Promise<void> => {
    const token = owner(req);
    try {
      res.json(
        GetFiatMintStatusResponse.parse({
          status: token ? await mint.status(token) : "none",
        }),
      );
    } catch {
      res
        .status(503)
        .json({ error: "Purchase recovery unavailable; do not pay again" });
    }
  });
  app.post("/api/fiat-mint/claim", guard, async (req, res): Promise<void> => {
    const token = owner(req);
    if (!token) {
      res.status(409).json({ error: "No owned checkout" });
      return;
    }
    try {
      const grant = await mint.claim(token);
      if (!grant) {
        res
          .status(409)
          .json({ error: "Not ready or already revealed; do not buy again" });
        return;
      }
      res.json(ClaimFiatMintMacaroonResponse.parse(grant));
    } catch {
      res.status(503).json({
        error:
          "Credential delivery interrupted; contact the operator before purchasing again",
      });
    }
  });
}
