import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  inspectSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../../src/lib/subscription-pass";
import {
  LIABILITY_CAVEAT,
  liabilityChallengeScope,
  LIMITATION_OF_LIABILITY,
} from "../../src/middleware/liability-notice";
import { registerPublicCors } from "../../src/middleware/publicCors";

const exactCaveat = 'liability = "charles_r_strogish_held_harmless"';
const exactHeader =
  "The Bitcoin Stratigraphy Data Engine and its architect, Charles R. Strogish, assume strictly zero liability for any downstream financial execution, hallucination, or logic failures by the client system. Use constitutes acceptance of these terms.";
const secret = "liability-test-only";
const options = {
  secret,
  paymentHash: "ab".repeat(32),
  tier: "1-day" as const,
  validUntil: 2_000_000_000,
  amountMsats: 1_000,
};
function decode(encoded: string) {
  return JSON.parse(Buffer.from(encoded, "base64url").toString()) as {
    identifier: string;
    caveats: string[];
    signature: string;
  };
}
function sign(token: ReturnType<typeof decode>): string {
  let signature = createHmac("sha256", secret)
    .update(token.identifier)
    .digest();
  for (const caveat of token.caveats)
    signature = createHmac("sha256", signature).update(caveat).digest();
  return Buffer.from(
    JSON.stringify({ ...token, signature: signature.toString("hex") }),
  ).toString("base64url");
}

test("all root tiers and settlement rails mint the exact signed liability notice", () => {
  assert.equal(LIABILITY_CAVEAT, exactCaveat);
  for (const tier of ["1-day", "30-day"] as const) {
    for (const paymentAsset of [undefined, "btc-lightning", "l-btc"] as const) {
      const encoded = createSubscriptionMacaroon({
        ...options,
        tier,
        ...(paymentAsset
          ? { paymentAsset, paymentProvider: "test-wallet" }
          : {}),
      });
      assert.equal(
        decode(encoded).caveats.filter((c) => c === exactCaveat).length,
        1,
      );
      const pass = verifySubscriptionMacaroon(encoded, secret, 1_999_999_999);
      assert.ok(pass);
      assert.equal(pass.paymentHash, options.paymentHash);
      assert.equal(pass.amountMsats, options.amountMsats);
      const tampered = decode(encoded);
      tampered.caveats = tampered.caveats.filter((c) => c !== exactCaveat);
      assert.equal(
        inspectSubscriptionMacaroon(
          Buffer.from(JSON.stringify(tampered)).toString("base64url"),
          secret,
        ),
        null,
      );
    }
  }
});

test("attenuation preserves the notice and every inherited quota scope", () => {
  const root = createSubscriptionMacaroon(options);
  const parent = attenuateSubscriptionMacaroon(root, ["max_requests=2"])!;
  const child = attenuateSubscriptionMacaroon(parent, [
    "max_requests=1",
    "allowed_path=/api/v1/stratigraphy",
  ])!;
  assert.equal(
    decode(child).caveats.filter((c) => c === exactCaveat).length,
    1,
  );
  const inspected = inspectSubscriptionMacaroon(child, secret)!;
  assert.equal(inspected.requestLimits.length, 2);
  assert.equal(
    inspected.requestLimits[0]!.tokenId,
    inspectSubscriptionMacaroon(parent, secret)!.requestLimits[0]!.tokenId,
  );
  assert.equal(inspected.maxRequests, 1);
  assert.equal(attenuateSubscriptionMacaroon(root, [exactCaveat]), null);
});

test("legacy paid tokens stay valid; malformed, altered or duplicate liability notices fail closed", () => {
  const token = decode(createSubscriptionMacaroon(options));
  const legacy = {
    ...token,
    caveats: token.caveats.filter((c) => c !== exactCaveat),
  };
  assert.ok(inspectSubscriptionMacaroon(sign(legacy), secret));
  for (const caveats of [
    [...legacy.caveats, 'liability = "someone_else_held_harmless"'],
    [...legacy.caveats, "liability=charles_r_strogish_held_harmless"],
    [...token.caveats, exactCaveat],
  ]) {
    assert.equal(
      inspectSubscriptionMacaroon(sign({ ...token, caveats }), secret),
      null,
    );
  }
  const oldScope = "subscription:1-day:5:asset:btc-lightning";
  assert.notEqual(liabilityChallengeScope(oldScope), oldScope);
  assert.equal(
    liabilityChallengeScope(oldScope),
    liabilityChallengeScope(oldScope),
  );
});

test("global notice covers cost, MCP, preflights, errors and rate-limited responses and is CORS-exposed", async (t) => {
  assert.equal(LIMITATION_OF_LIABILITY, exactHeader);
  const app = express();
  registerPublicCors(app, (req, res, next) => {
    if (req.path === "/rate-limited")
      res.status(429).json({ error: "test limit" });
    else next();
  });
  app.use(express.json({ limit: "1kb" }));
  app.get("/api/v1/cost", (_req, res) => res.json({ total_sats: 1 }));
  app.post("/api/v1/cost", (_req, res) => res.json({ total_sats: 1 }));
  app.post("/mcp", (_req, res) =>
    res.status(402).json({ error: "payment required" }),
  );
  app.get("/error", () => {
    throw new Error("test error");
  });
  app.use(
    (
      error: Error & { status?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      res.status(error.status ?? 500).json({ error: "test response" });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [path, method, body, status] of [
    ["/api/v1/cost", "GET", undefined, 200],
    ["/api/v1/cost", "POST", "{}", 200],
    ["/mcp", "POST", "{}", 402],
    ["/mcp", "OPTIONS", undefined, 200],
    ["/api/v1/cost", "OPTIONS", undefined, 200],
    ["/api/v1/cost", "POST", "{", 400],
    ["/api/v1/cost", "POST", JSON.stringify({ large: "x".repeat(2_000) }), 413],
    ["/rate-limited", "GET", undefined, 429],
    ["/missing", "GET", undefined, 404],
    ["/error", "GET", undefined, 500],
  ] as const) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        origin: "https://agent.example",
        ...(method === "OPTIONS"
          ? { "access-control-request-headers": "Authorization" }
          : {}),
      },
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(
      response.headers.get("X-Limitation-Of-Liability"),
      exactHeader,
    );
    assert.ok(
      response.headers
        .get("access-control-expose-headers")!
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .includes("x-limitation-of-liability"),
    );
    await response.arrayBuffer();
  }
});
