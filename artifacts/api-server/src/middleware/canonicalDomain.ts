import type { RequestHandler } from "express";
import { CANONICAL_ORIGIN } from "../lib/public-site";

/** Redirect legacy hosts before aliases, logging, parsing, rate limits or paid work. */
export const redirectLegacyDomain: RequestHandler = (req, res, next) => {
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/(?:^|\.)(?:replit\.app|replit\.dev|repl\.co)$/i.test(hostname)) return next();
  const originalPath = req.originalUrl ?? req.url ?? "/";
  res.statusCode = 301;
  res.setHeader("Location", CANONICAL_ORIGIN + (originalPath.startsWith("/") ? originalPath : "/"));
  res.end();
};
