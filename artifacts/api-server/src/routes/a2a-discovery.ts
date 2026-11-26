// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash, type KeyObject } from "node:crypto";
import type { Express } from "express";
import { A2A_DISCOVERY_PATHS, buildA2aDiscovery } from "../lib/a2a-agent-card";

/** Public static documents; serialize final signed fields once, before serving. */
export function registerA2aDiscoveryRoutes(
  app: Express,
  integrityKey: KeyObject,
): void {
  const { agentCard, jwks } = buildA2aDiscovery(integrityKey);
  for (const [path, document, mediaType] of [
    [A2A_DISCOVERY_PATHS[0], agentCard, "application/json"],
    [A2A_DISCOVERY_PATHS[1], jwks, "application/jwk-set+json"],
  ] as const) {
    const body = JSON.stringify(document);
    const etag = `"${createHash("sha256").update(body, "utf8").digest("hex")}"`;
    app.get(path, (req, res) => {
      res.set({
        "Content-Type": `${mediaType}; charset=utf-8`,
        "Cache-Control": "public, max-age=3600",
        ETag: etag,
      });
      if (
        req
          .get("If-None-Match")
          ?.split(",")
          .some((item) => {
            const value = item.trim();
            return value === "*" || value === etag || value === `W/${etag}`;
          })
      ) {
        res.status(304).end();
        return;
      }
      res.status(200).send(body);
    });
  }
}
