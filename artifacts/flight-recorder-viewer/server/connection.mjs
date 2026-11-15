// Copyright (c) 2026 Charles R. Strogish. AGPL-3.0-only.
export const VERIFICATION_URL = "https://bitcoinstratigraphy.com/api/mint-macaroon";

/** No keys, credentials, upstream bodies or wallet data ever leave this boundary. */
export function createConnectionService({ key = () => process.env.BITCOIN_STRATIGRAPHY_API_KEY, fetcher = fetch, now = Date.now } = {}) {
  let checked;
  let checkedKey;
  let entitlementExpires = 0;
  let inflight;
  let lastAttempt = -Infinity;
  const snapshot = (status, message) => ({
    configured: Boolean(key()?.trim()),
    status,
    message,
    checkedAt: new Date(now()).toISOString(),
  });
  function status() {
    const credential = key()?.trim();
    if (!credential) return snapshot("missing", "Enterprise API credential is not configured.");
    if (checked && checkedKey === credential && now() - lastAttempt < 60_000) {
      if (checked.status === "verified" && now() >= entitlementExpires) {
        return snapshot("invalid", "Enterprise entitlement has expired.");
      }
      return checked;
    }
    return snapshot("unverified", "Credential configured. Verify your funded Enterprise API Block to connect.");
  }
  async function verify() {
    const credential = key()?.trim();
    if (!credential) return status();
    if (inflight) return inflight;
    if (checked && checkedKey === credential && now() - lastAttempt < 10_000) return status();
    if (!/^(?:Macaroon )?[A-Za-z0-9_-]{1,8192}$/.test(credential)) {
      return snapshot("invalid", "Expected a prepaid scanner macaroon, optionally prefixed with Macaroon.");
    }
    checkedKey = credential;
    lastAttempt = now();
    inflight = (async () => {
      try {
        // The issuer's idempotent funded-credit check consumes no scan credit.
        // Never request a new invoice, call a paid tool or initiate a payment.
        const response = await fetcher(VERIFICATION_URL, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
          headers: {
            Authorization: credential.startsWith("Macaroon ") ? credential : `Macaroon ${credential}`,
            Accept: "application/json",
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          return snapshot(
            [400, 401, 402, 403, 409, 429].includes(response.status) ? "invalid" : "unavailable",
            response.status === 409
              ? "Original payment is not confirmed. Recover your existing purchase; no new payment was created."
              : "Enterprise entitlement could not be confirmed. Check the credential or retry later.",
          );
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Missing response");
        let bytes = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 16_384) throw new Error("Oversized response");
            chunks.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const grant = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const expected = credential.replace(/^Macaroon /, "");
        const expiry = Number.isSafeInteger(grant.valid_until) ? grant.valid_until * 1_000 : NaN;
        if (grant.macaroon !== expected || grant.scope !== "/api/scanner" ||
            grant.amount_sats !== 100_000 || !Number.isInteger(grant.credits) ||
            grant.credits <= 0 || grant.credits > 100 || !Number.isFinite(expiry) || expiry <= now()) {
          return snapshot("invalid", "No active funded scanner entitlement was confirmed.");
        }
        entitlementExpires = expiry;
        return snapshot("verified", "Funded scanner entitlement verified. Viewer telemetry remains a demonstration.");
      } catch {
        // Do not serialize upstream exceptions: they may contain bearer material.
        return snapshot("unavailable", "Issuer verification is unavailable. No payment or scan was initiated.");
      }
    })();
    try {
      checked = await inflight;
      return checked;
    } finally {
      inflight = undefined;
    }
  }
  return { status, verify };
}

/** Shared by the development and standalone production servers. */
export function connectionMiddleware(service, basePath = "/") {
  const prefix = `${basePath.replace(/\/?$/, "/")}local-api/`;
  return async (req, res, next) => {
    const pathname = req.url?.split("?")[0];
    if (pathname !== `${prefix}status` && pathname !== `${prefix}verify`) return next();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const reply = (code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); };
    if (pathname.endsWith("/status") && req.method === "GET") return reply(200, service.status());
    if (pathname.endsWith("/verify") && req.method === "POST") {
      try {
        if (req.headers["sec-fetch-site"] === "cross-site" ||
            (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
          return reply(403, { error: "Same-origin request required" });
        }
      } catch {
        return reply(403, { error: "Invalid request origin" });
      }
      return reply(200, await service.verify());
    }
    res.setHeader("Allow", pathname.endsWith("/status") ? "GET" : "POST");
    return reply(405, { error: "Method not allowed" });
  };
}
