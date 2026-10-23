import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, RequestHandler } from "express";
import {
  normalizeNip98Pubkey, type Nip98RevocationStore,
} from "../lib/nip98-revocation-store";
import { verifyRequestNip98Signer } from "../lib/nip98-request";

/** Run after exact raw-body capture, before invoicing, caches or execution. */
export function createNip98RevocationGuard(
  store: Nip98RevocationStore,
  now = Date.now,
): RequestHandler {
  return async (req, res, next) => {
    const identity = verifyRequestNip98Signer(req, now());
    if (!identity.provided) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    if (!identity.pubkey) {
      res.status(401).json({ error: "Invalid NIP-98 request signature" });
      return;
    }
    try {
      if (await store.isRevoked(identity.pubkey)) {
        res.status(403).json({ error: "NIP-98 agent key is revoked" });
        return;
      }
    } catch {
      res.status(503).json({ error: "NIP-98 revocation registry unavailable" });
      return;
    }
    next();
  };
}

export function registerNip98RevocationAdmin(
  app: Express,
  store: Nip98RevocationStore,
  operatorSecret = process.env.MACAROON_OPERATOR_SECRET,
): void {
  app.post("/api/admin/revoke_key", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!operatorSecret) {
      res.status(503).json({ error: "Operator authorization is not configured" });
      return;
    }
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(
      digest(req.get("Authorization") ?? ""),
      digest(`Bearer ${operatorSecret}`),
    )) {
      res.status(403).json({ error: "Operator authorization required" });
      return;
    }
    let pubkey: string;
    try {
      if (Object.keys(req.body ?? {}).some((key) => key !== "pubkey")) {
        throw new Error("Unexpected field");
      }
      pubkey = normalizeNip98Pubkey(req.body?.pubkey);
    } catch {
      res.status(400).json({ error: "Provide only a 64-character hex pubkey" });
      return;
    }
    try {
      res.status(200).json(await store.revoke(pubkey));
    } catch {
      res.status(503).json({ error: "NIP-98 revocation could not be persisted" });
    }
  });
}
