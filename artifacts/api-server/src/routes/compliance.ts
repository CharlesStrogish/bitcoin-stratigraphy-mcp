// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import type { KeyObject } from "node:crypto";
import type {
  Nip98RegistrySnapshot,
  Nip98RevocationStore,
} from "../lib/nip98-revocation-store";
import {
  issuerKeyId,
  loadArticle12IssuerKey,
  signIssuerPayload,
} from "../lib/article12-signature";

export const SNAPSHOT_LIFETIME_MS = 15 * 60 * 1000;

export function signRevocationSnapshot(
  registry: Nip98RegistrySnapshot,
  key: KeyObject,
): Record<string, unknown> {
  const asOf = new Date(registry.as_of);
  if (!Number.isFinite(asOf.getTime()))
    throw new Error("Invalid registry capture time");
  const seen = new Set<string>();
  const revoked = registry.revoked_keys
    .map((entry) => {
      const revokedAt = new Date(entry.revoked_at);
      if (
        !/^[0-9a-f]{64}$/.test(entry.pubkey) ||
        seen.has(entry.pubkey) ||
        !Number.isFinite(revokedAt.getTime()) ||
        revokedAt > asOf
      ) {
        throw new Error("Invalid registry snapshot");
      }
      seen.add(entry.pubkey);
      return { pubkey: entry.pubkey, revoked_at: revokedAt.toISOString() };
    })
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  return signIssuerPayload(
    {
      snapshot_type: "nip98-revocation-snapshot-v1",
      as_of: asOf.toISOString(),
      next_update: new Date(
        asOf.getTime() + SNAPSHOT_LIFETIME_MS,
      ).toISOString(),
      issuer_key_id: issuerKeyId(key),
      revoked_keys: revoked,
    },
    key,
    "nip98-crl-ed25519-v1",
    "bitcoin-stratigraphy/nip98-crl/v1\n",
  );
}

export function registerComplianceRoutes(
  app: Express,
  store: Nip98RevocationStore,
  loadKey: () => KeyObject = loadArticle12IssuerKey,
): void {
  app.get("/api/v1/compliance/revocation-snapshot", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(signRevocationSnapshot(await store.snapshot(), loadKey()));
    } catch (error) {
      req.log?.error({ err: error }, "Compliance snapshot unavailable");
      res.status(503).json({ error: "Signed revocation snapshot unavailable" });
    }
  });
}
