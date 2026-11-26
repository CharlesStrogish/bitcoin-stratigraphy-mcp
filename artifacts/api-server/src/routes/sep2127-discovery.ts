// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash } from "node:crypto";
import type { Express } from "express";
import {
  AI_CATALOG_MEDIA_TYPE,
  MCP_SERVER_CARD_MEDIA_TYPE,
  SEP2127_PATHS,
  buildSep2127Discovery,
} from "../lib/sep2127-discovery";

/** Mount after public CORS/rate limits, before MCP, identity and payment gates. */
export function registerSep2127DiscoveryRoutes(app: Express): void {
  const { serverCard, catalog } = buildSep2127Discovery();
  for (const [paths, document, mediaType] of [
    [[SEP2127_PATHS[0]], catalog, AI_CATALOG_MEDIA_TYPE],
    [
      [SEP2127_PATHS[1], SEP2127_PATHS[2]],
      serverCard,
      MCP_SERVER_CARD_MEDIA_TYPE,
    ],
  ] as const) {
    const body = JSON.stringify(document);
    const etag = `"${createHash("sha256").update(body, "utf8").digest("hex")}"`;
    // Express GET includes HEAD. Compare weak or strong If-None-Match validators
    // even when a client asks caches to revalidate with Cache-Control: no-cache.
    // Pre-serialize once so both aliases and their validators cover exact bytes.
    app.get([...paths], (req, res) => {
      res.set({
        "Content-Type": `${mediaType}; charset=utf-8`,
        "Cache-Control": "public, max-age=3600",
        ETag: etag,
      });
      const validators = req
        .get("If-None-Match")
        ?.split(",")
        .map((value) => value.trim());
      if (
        validators?.some(
          (value) => value === "*" || value === etag || value === `W/${etag}`,
        )
      ) {
        res.status(304).end();
        return;
      }
      res.status(200).send(body);
    });
  }
}
