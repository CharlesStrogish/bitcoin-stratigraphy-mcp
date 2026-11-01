import type { RequestHandler } from "express";
import { logger } from "../lib/logger";

const DISCOVERY_PATHS = new Set([
  "/openapi.json",
  "/.well-known/ai-plugin.json",
  "/.well-known/mcp-configuration.json",
  "/robots.txt",
  "/sitemap.xml",
  "/yield-proofs.json",
]);
const AI_USER_AGENT = /GPTBot|ClaudeBot|Anthropic|axios|node-fetch|python-requests/i;
const MESSAGE = "[SWARM RADAR] 🤖 AI/Crawler Detected";

type RadarEvent = {
  event: "swarm_radar";
  route: string;
  ip: string;
  agent: string;
};

function safeField(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/** Observational only: no body access, response changes, network calls or awaits. */
export function createSwarmRadar(
  write: (event: RadarEvent) => void = (event) => logger.info(event, MESSAGE),
): RequestHandler {
  return (req, _res, next) => {
    try {
      const route = req.path;
      const agent = req.get("User-Agent") ?? "";
      if (
        DISCOVERY_PATHS.has(route.toLowerCase().replace(/\/$/, "")) ||
        AI_USER_AGENT.test(agent)
      ) {
        // Copy bounded fields, not the request, headers, credentials or query.
        const event: RadarEvent = {
          event: "swarm_radar",
          route: safeField(route, 1024),
          ip: safeField(req.ip ?? "", 128),
          agent: safeField(agent, 512),
        };
        setImmediate(() => {
          try {
            write(event);
          } catch {
            // Optional telemetry must never turn a logger outage into an API failure.
          }
        }).unref();
      }
    } catch {
      // Even malformed request metadata must not affect authorization or routing.
    }
    next();
  };
}
