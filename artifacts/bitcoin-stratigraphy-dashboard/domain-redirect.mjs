const canonicalOrigin = "https://bitcoinstratigraphy.com";
const legacyHost = /(?:^|\.)(?:replit\.app|replit\.dev|repl\.co)$/i;

/** Only the actual Host header controls redirects; never trust client forwarding headers. */
export function redirectLegacyDomain(req, res, next) {
  const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (!legacyHost.test(hostname)) return next();
  const originalPath = req.originalUrl ?? req.url ?? "/";
  res.statusCode = 301;
  res.setHeader("Location", canonicalOrigin + (originalPath.startsWith("/") ? originalPath : "/"));
  res.end();
}
