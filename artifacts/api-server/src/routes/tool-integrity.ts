// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import {
  createToolIntegrityManifest,
  loadToolIntegrityKey,
  type IntegrityTool,
} from "../lib/tool-integrity";

/** Call only after the final MCP registry and all description overrides exist. */
export function registerToolIntegrityRoute(
  app: Express,
  tools: readonly IntegrityTool[],
  privateKey = loadToolIntegrityKey(),
) {
  const manifest = createToolIntegrityManifest(tools, privateKey);
  // Native resources/read and HTTP expose the identical startup snapshot.
  app.locals.toolIntegrityManifest = manifest;
  app.get("/.well-known/integrity.json", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json(manifest);
  });
  return manifest;
}
