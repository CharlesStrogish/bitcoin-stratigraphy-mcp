// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { randomBytes } from "node:crypto";
import type { Express, Request } from "express";
import {
  McpUrlElicitation,
  UrlHandoffError,
  URL_HANDOFF_STATUS,
  URL_HANDOFF_PAGE,
  MCP_HANDOFF_HEADER,
  scannerHandoffReference,
} from "../lib/mcp-url-elicitation";
import { checkoutHandoffHtml } from "../lib/mcp-checkout-page";
import { GetMcpCheckoutHandoffStatusResponse } from "@workspace/api-zod";

const affected = new Set([
  "/api/fiat-mint",
  "/api/fiat-mint/status",
  "/api/fiat-mint/claim",
  "/api/v1/waivers/quote",
  "/api/v1/waivers/claim",
]);
function fiatCookie(value: string | string[] | undefined) {
  const cookies = Array.isArray(value) ? value : [value ?? ""];
  return cookies
    .flatMap((cookie) => cookie.split(";").map((part) => part.trim()))
    .find((part) => /^__Secure-fiat-mint-owner=[0-9a-f]{64}$/.test(part))
    ?.split("=")[1];
}
const sourcePath = (req: Request) => req.originalUrl.split("?")[0]!;

/** Register before the existing checkout routes. Neither service is replaced:
 * only opted-in browser requests are correlated, after their original checks. */
export function registerMcpUrlElicitationRoutes(
  app: Express,
  service: McpUrlElicitation,
) {
  app.get(URL_HANDOFF_PAGE, (_req, res) => {
    const nonce = randomBytes(18).toString("base64");
    res
      .set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'`,
      })
      .type("html")
      .send(checkoutHandoffHtml(nonce));
  });
  app.get(URL_HANDOFF_STATUS + "/:elicitationId", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      const owner = service.ownerHash(req);
      const id = String(req.params.elicitationId);
      res.json(
        GetMcpCheckoutHandoffStatusResponse.parse(
          service.publicStatus(await service.getHandoffStatus(id, owner)),
        ),
      );
    } catch (error) {
      res.status(error instanceof UrlHandoffError ? error.status : 503).json({
        error:
          error instanceof UrlHandoffError
            ? error.message
            : "Checkout handoff storage unavailable",
      });
    }
  });
  app.use(async (req, res, next) => {
    const id = req.get(MCP_HANDOFF_HEADER);
    const path = sourcePath(req);
    if (!id || req.method !== "POST" || !affected.has(path)) return next();
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      // Same-origin browser action in addition to the cryptographic caller proof.
      // Existing checkout's own stricter origin/body/payment checks still run.
      const origin = req.get("origin");
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(
          origin &&
          new URL(origin).origin === `${req.protocol}://${req.get("host")}`,
        );
      } catch {
        /* fail closed */
      }
      if (!sameOrigin || req.get("sec-fetch-site") === "cross-site")
        throw new UrlHandoffError(403, "Same-origin checkout action required");
      const owner = service.ownerHash(req);
      const row = await service.getHandoffStatus(id, owner);
      const scanner = path.startsWith("/api/fiat-mint");
      if (
        row.intent !==
        (scanner ? "scanner_pack_checkout" : "agpl_waiver_checkout")
      )
        throw new UrlHandoffError(403, "Checkout intent mismatch");
      if (row.status !== "pending")
        throw new UrlHandoffError(
          409,
          "Handoff completed; recover the existing purchase directly",
        );
      const cookie = fiatCookie(req.headers.cookie);
      const knownReference = scanner
        ? cookie && scannerHandoffReference(cookie)
        : typeof req.body?.quote_id === "string"
          ? "waiver:" + req.body.quote_id
          : undefined;
      if (
        row.referenceId &&
        path !== "/api/v1/waivers/quote" &&
        row.referenceId !== knownReference
      )
        throw new UrlHandoffError(
          403,
          "Checkout ownership or reference mismatch",
        );
      if (path === "/api/v1/waivers/claim" && !row.referenceId)
        throw new UrlHandoffError(
          403,
          "Waiver quote was not created through this owner-bound handoff",
        );
      const startsCheckout =
        path === "/api/fiat-mint" || path === "/api/v1/waivers/quote";
      if (startsCheckout) await service.reserveCheckout(id, owner);
      const send = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        void (async () => {
          const payload = body as Record<string, unknown> | null;
          if (status >= 200 && status < 300 && payload) {
            if (path === "/api/fiat-mint" && typeof payload.url === "string") {
              const buyer = fiatCookie(
                res.getHeader("set-cookie") as string | string[] | undefined,
              );
              if (!buyer)
                throw new Error("Checkout ownership cookie unavailable");
              await service.bindReference(
                id,
                owner,
                scannerHandoffReference(buyer),
              );
            } else if (
              path === "/api/v1/waivers/quote" &&
              typeof payload.quote_id === "string"
            ) {
              await service.bindReference(
                id,
                owner,
                "waiver:" + payload.quote_id,
              );
            } else if (
              scanner &&
              knownReference &&
              ((path === "/api/fiat-mint/status" &&
                ["ready", "delivered"].includes(String(payload.status))) ||
                (path === "/api/fiat-mint/claim" &&
                  typeof payload.macaroon === "string"))
            ) {
              // These responses come only from the original owner-checked mint.
              // In particular, client request bodies cannot assert completion.
              await service.bindReference(id, owner, knownReference);
              await service.markHandoffCompleted(id, owner, knownReference);
            } else if (
              path === "/api/v1/waivers/claim" &&
              knownReference &&
              typeof payload.signature === "string" &&
              typeof payload.waiver_id === "string"
            ) {
              await service.markHandoffCompleted(id, owner, knownReference);
            }
          } else if (startsCheckout && [400, 403].includes(status)) {
            await service.releaseRejectedCheckout(id, owner);
          }
          send(body);
        })().catch(() => {
          req.log?.error(
            "Verified checkout correlation unavailable; existing purchase must be recovered",
          );
          res.status(503);
          send({
            error:
              "Checkout correlation unavailable; keep your existing purchase and recover it before paying again",
          });
        });
        return res;
      }) as typeof res.json;
      next();
    } catch (error) {
      res.status(error instanceof UrlHandoffError ? error.status : 503).json({
        error:
          error instanceof UrlHandoffError
            ? error.message
            : "Checkout handoff unavailable",
      });
    }
  });
}
