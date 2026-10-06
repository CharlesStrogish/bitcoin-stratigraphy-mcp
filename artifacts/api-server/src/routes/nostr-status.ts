// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { getNostrHeartbeatStatus } from "../lib/nostr-heartbeat";
import {
  getNostrDiscoveryStatus,
  parseNip05Identifier,
} from "../services/announcer";

export function registerNostrStatusRoute(app: Express): void {
  app.get("/api/v1/nostr/status", (_req, res): void => {
    res.status(200).json(getNostrHeartbeatStatus());
  });
  app.get("/api/v1/nostr/info", (_req, res): void => {
    res.status(200).json(getNostrDiscoveryStatus());
  });
  app.get("/.well-known/nostr.json", (req, res): void => {
    const status = getNostrDiscoveryStatus();
    const configured = parseNip05Identifier(status.nip05 ?? undefined);
    const requestedName =
      typeof req.query.name === "string"
        ? req.query.name.trim().toLowerCase()
        : "";
    if (
      !configured ||
      requestedName !== configured.name ||
      req.hostname.toLowerCase() !== configured.domain ||
      !status.public_key.hex
    ) {
      res.status(404).json({ names: {} });
      return;
    }
    res.status(200).json({
      names: { [configured.name]: status.public_key.hex },
      relays: {
        [status.public_key.hex]: status.relays.map(({ relay }) => relay),
      },
    });
  });
}