import type { Express, RequestHandler } from "express";
import { LIMITATION_OF_LIABILITY } from "./liability-notice";
import { CANONICAL_ORIGIN } from "../lib/public-site";

export const PUBLIC_ALLOWED_ORIGINS: readonly string[] = [
  CANONICAL_ORIGIN,
  "https://www.bitcoinstratigraphy.com",
];

/**
 * Public API CORS is token-based, not cross-origin cookie authentication.
 * Baseline security headers ride along; routes may tighten them further.
 */
export function registerPublicCors(
  app: Express,
  publicRateLimit?: RequestHandler,
): void {
  app.use((req, res, next) => {
    const origin = req.get("Origin");
    res.vary("Origin");
    res.set({
      "X-Limitation-Of-Liability": LIMITATION_OF_LIABILITY,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Access-Control-Allow-Origin":
        origin && PUBLIC_ALLOWED_ORIGINS.includes(origin) ? origin : "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": [
        "*",
        "WWW-Authenticate",
        "X-Limitation-Of-Liability",
        "X-L402-Receipt",
        "X-L402-Licensing-Compliance",
        "X-Commercial-Exemption-Status",
        "X-Commercial-Exemption-Token",
        "X-Commercial-Exemption-Expires",
        "X-Stratigraphy-Records",
        "X-Stratigraphy-First-Day",
        "X-Stratigraphy-Last-Day",
        "X-L402-Cost-Sats",
        "X-L402-Minimum-Cost-Sats",
        "X-L402-Subscription-Tiers",
      ].join(", "),
    });
    // A wildcard origin cannot be combined with credentialed browser CORS.
    res.removeHeader("Access-Control-Allow-Credentials");
    next();
  });

  // Set CORS on 429s too, and count public preflights before terminating them.
  if (publicRateLimit) app.use(publicRateLimit);

  const preflight: RequestHandler = (req, res) => {
    res.vary("Access-Control-Request-Headers");
    const headers = req.get("Access-Control-Request-Headers") ?? "";
    if (
      headers
        .split(",")
        .some((header) => header.trim().toLowerCase() === "authorization")
    ) {
      // Authorization is a Fetch non-wildcard request-header name, even when
      // credentials are omitted. Other requested headers remain covered by *.
      res.set("Access-Control-Allow-Headers", "*, Authorization");
    }
    res.status(200).end();
  };

  // Terminate these probes before JSON parsing, RPC or payment middleware.
  app.options(["/mcp", "/.well-known/mcp/server-card.json"], preflight);
  // Express 5 requires a regex rather than "*" for the catch-all path.
  app.options(/.*/, preflight);
}
