// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import type { RequestHandler } from "express";

// The OpenAPI document gives these root routes their own origin-level
// servers, but some clients resolve every path against the "/api" server
// anyway: /api/openapi.json, /api/mcp and /api/.well-known/* reach the same
// routes as their root URLs.
const API_ROOT_ALIAS =
  /^\/api(?=\/(?:openapi\.json|mcp\/?|\.well-known\/[^?#]+)(?:[?#]|$))/i;

export function rewriteApiRootAlias(url: string): string {
  return API_ROOT_ALIAS.test(url) ? url.slice("/api".length) : url;
}

/**
 * Must run before every other middleware, so CORS, rate limits, request
 * guards and payment checks treat an alias exactly like its root URL.
 * req.originalUrl keeps the URL the client requested, which NIP-98 request
 * signatures cover.
 */
export const apiRootAliases: RequestHandler = (req, _res, next) => {
  req.url = rewriteApiRootAlias(req.url);
  next();
};
