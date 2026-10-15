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
  // NIP-05 clients read this document from browsers and treat anything but
  // JSON as a failed lookup, so it is always a 200 JSON answer with wildcard
  // CORS; a name it does not serve gets an empty "names" map, not a 404.
  // (/api/.well-known/nostr.json reaches this route through the /api aliases.)
  app.get("/.well-known/nostr.json", (req, res): void => {
    res.set("Access-Control-Allow-Origin", "*");
    const status = getNostrDiscoveryStatus();
    const publicKey = status.public_key.hex;
    const configured = parseNip05Identifier(status.nip05 ?? undefined);
    // Without a configured identifier the announcing key is the root identity
    // ("_") of whichever domain serves this document. A configured
    // name@domain identity is only claimed on its own domain.
    const name = configured?.name ?? "_";
    const requestedName =
      typeof req.query.name === "string" && req.query.name.trim()
        ? req.query.name.trim().toLowerCase()
        : undefined;
    const serves =
      publicKey !== null &&
      (requestedName === undefined || requestedName === name) &&
      (!configured || req.hostname.toLowerCase() === configured.domain);
    res.status(200).json(
      serves
        ? {
            names: { [name]: publicKey },
            relays: { [publicKey]: status.relays.map(({ relay }) => relay) },
          }
        : { names: {} },
    );
  });
}
