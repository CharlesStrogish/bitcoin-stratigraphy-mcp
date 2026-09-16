import type { Express } from "express";
import { getNostrHeartbeatStatus } from "../lib/nostr-heartbeat";

export function registerNostrStatusRoute(app: Express): void {
  app.get("/api/v1/nostr/status", (_req, res): void => {
    res.status(200).json(getNostrHeartbeatStatus());
  });
}