// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express from "express";
import { A2A_DISCOVERY_PATHS, buildA2aDiscovery } from "../lib/a2a-agent-card";
import { issuerKeyId } from "../lib/article12-signature";
import { jcs } from "../lib/jcs";
import {
  CANONICAL_ORIGIN,
  RELEASE_VERSION,
  canonicalUrl,
} from "../lib/public-site";
import { apiRootAliases } from "../middleware/apiRootAliases";
import { registerPublicCors } from "../middleware/publicCors";
import { registerA2aDiscoveryRoutes } from "./a2a-discovery";
import { registerSep2127DiscoveryRoutes } from "./sep2127-discovery";

// Synthetic keys only: tests must never load/export configured private material.
const key = generateKeyPairSync("ed25519").privateKey;

async function serve(t: TestContext) {
  const app = express();
  app.use(apiRootAliases);
  registerPublicCors(app);
  registerA2aDiscoveryRoutes(app, key);
  registerSep2127DiscoveryRoutes(app);
  let gateCalls = 0;
  app.use(express.json());
  app.use((_req, res) => {
    gateCalls++;
    res.status(402).end();
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    gateCalls: () => gateCalls,
  };
}

test("A2A v1.0 card makes only honest MCP interface and capability claims", () => {
  const { agentCard: card, jwks } = buildA2aDiscovery(key);
  assert.equal(card.name, "Bitcoin Stratigraphy");
  assert.equal(
    card.description,
    "Bitcoin L402 telemetry engine, OpenTimestamps notary, and tamper-evident AI audit hub for autonomous MCP swarms.",
  );
  assert.equal(card.version, RELEASE_VERSION);
  assert.match(
    card.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  assert.deepEqual(card.provider, {
    organization: "Bitcoin Stratigraphy",
    url: CANONICAL_ORIGIN,
  });
  assert.equal(card.documentationUrl, canonicalUrl("/docs"));
  assert.deepEqual(card.supportedInterfaces, [
    {
      url: canonicalUrl("/mcp"),
      protocolBinding:
        "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http",
      protocolVersion: "1.0",
    },
  ]);
  assert.deepEqual(card.capabilities, {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
  });
  assert.deepEqual(card.defaultInputModes, ["application/json", "text/plain"]);
  assert.deepEqual(card.defaultOutputModes, ["application/json"]);
  assert.equal(card.securitySchemes.l402.httpAuthSecurityScheme.scheme, "L402");
  assert.equal(
    card.securitySchemes.l402.httpAuthSecurityScheme.description,
    "Bitcoin Lightning L402 capability macaroon and payment preimage (Authorization: L402 <macaroon>:<preimage>).",
  );
  assert.equal("url" in card, false);
  assert.equal("preferredTransport" in card, false);
  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    [
      "bitcoin-state-grounding",
      "opentimestamps-notarization",
      "l402-capability-delegation",
    ],
  );
  for (const skill of card.skills) {
    assert.deepEqual(Object.keys(skill).sort(), [
      "description",
      "examples",
      "id",
      "name",
      "tags",
    ]);
    for (const value of [
      skill.id,
      skill.name,
      skill.description,
      ...skill.tags,
      ...skill.examples,
    ])
      assert.ok(typeof value === "string" && value.length > 0);
    assert.ok(skill.tags.length && skill.examples.length);
    assert.equal("inputSchema" in skill || "outputSchema" in skill, false);
  }
  const jwk = jwks.keys[0]!;
  assert.deepEqual(Object.keys(jwk).sort(), [
    "alg",
    "crv",
    "kid",
    "kty",
    "use",
    "x",
  ]);
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.equal(jwk.alg, "EdDSA");
  assert.equal(jwk.use, "sig");
  assert.match(jwk.x, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(jwk.x, "base64url").length, 32);
  assert.equal(jwk.kid, issuerKeyId(key));
  assert.equal("d" in jwk, false);
  assert.ok(
    !/PRIVATE KEY|localhost|127\.0\.0\.1/.test(JSON.stringify({ card, jwks })),
  );
});

test("A2A signing is deterministic and fails closed for non-private/non-Ed25519 keys", () => {
  assert.equal(
    JSON.stringify(buildA2aDiscovery(key)),
    JSON.stringify(buildA2aDiscovery(key)),
  );
  assert.throws(
    () => buildA2aDiscovery(createPublicKey(key)),
    /Ed25519 private key/,
  );
  assert.throws(
    () => buildA2aDiscovery(generateKeyPairSync("x25519").privateKey),
    /Ed25519 private key/,
  );
  const first = buildA2aDiscovery(key);
  first.agentCard.skills.length = 0;
  assert.equal(buildA2aDiscovery(key).agentCard.skills.length, 3);
});

test("HTTP A2A detached JWS verifies with fetched public JWKS; field/header/signature tampering fails", async (t) => {
  const { base } = await serve(t);
  const cardResponse = await fetch(base + A2A_DISCOVERY_PATHS[0]);
  const jwksResponse = await fetch(base + A2A_DISCOVERY_PATHS[1]);
  assert.equal(cardResponse.status, 200);
  assert.equal(jwksResponse.status, 200);
  const card = (await cardResponse.json()) as ReturnType<
    typeof buildA2aDiscovery
  >["agentCard"];
  const { keys } = (await jwksResponse.json()) as ReturnType<
    typeof buildA2aDiscovery
  >["jwks"];
  const { signatures, ...unsigned } = card;
  assert.equal(signatures.length, 1);
  const signature = signatures[0]!;
  assert.deepEqual(Object.keys(signature).sort(), ["protected", "signature"]);
  const header = JSON.parse(
    Buffer.from(signature.protected, "base64url").toString("utf8"),
  );
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  assert.ok(jwk);
  assert.equal("d" in jwk, false);
  assert.deepEqual(header, {
    alg: "EdDSA",
    typ: "JOSE",
    kid: jwk.kid,
    jku: canonicalUrl(A2A_DISCOVERY_PATHS[1]),
  });
  assert.equal(
    Buffer.from(signature.protected, "base64url").toString("utf8"),
    jcs(header),
  );
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  assert.deepEqual(
    publicKey.export({ format: "der", type: "spki" }),
    createPublicKey(key).export({ format: "der", type: "spki" }),
  );
  const input = (value: unknown, protectedHeader = signature.protected) =>
    Buffer.from(
      `${protectedHeader}.${Buffer.from(jcs(value), "utf8").toString("base64url")}`,
      "ascii",
    );
  const bytes = Buffer.from(signature.signature, "base64url");
  assert.equal(bytes.length, 64);
  assert.equal(verify(null, input(unsigned), publicKey, bytes), true);
  assert.equal(
    verify(
      null,
      input({ ...unsigned, description: unsigned.description + "!" }),
      publicKey,
      bytes,
    ),
    false,
  );
  const altered = structuredClone(unsigned);
  altered.supportedInterfaces[0]!.url += "x";
  assert.equal(verify(null, input(altered), publicKey, bytes), false);
  const changedHeader = Buffer.from(jcs({ ...header, kid: "wrong" })).toString(
    "base64url",
  );
  assert.equal(
    verify(null, input(unsigned, changedHeader), publicKey, bytes),
    false,
  );
  const changedSignature = Buffer.from(bytes);
  changedSignature[0] = changedSignature[0]! ^ 1;
  assert.equal(
    verify(null, input(unsigned), publicKey, changedSignature),
    false,
  );
  assert.equal(
    verify(null, input(card), publicKey, bytes),
    false,
    "signatures must be excluded",
  );
  assert.equal(
    verify(
      null,
      Buffer.from(`${signature.protected}.${jcs(unsigned)}`),
      publicKey,
      bytes,
    ),
    false,
    "not RFC 7797 unencoded payload",
  );
  const reordered = Object.fromEntries(Object.entries(unsigned).reverse());
  assert.equal(
    verify(null, input(reordered), publicKey, bytes),
    true,
    "key ordering does not alter JCS signatures",
  );
  const catalog = (await (
    await fetch(base + "/.well-known/ai-catalog.json")
  ).json()) as { entries: { type: string; url: string; data?: unknown }[] };
  assert.deepEqual(
    catalog.entries.map((entry) => entry.type),
    ["application/mcp-server-card+json", "application/a2a-agent-card+json"],
  );
  for (const entry of catalog.entries) {
    assert.equal("data" in entry, false);
    const linked = await fetch(base + new URL(entry.url).pathname);
    assert.equal(linked.status, 200);
  }
});

for (const [index, path] of A2A_DISCOVERY_PATHS.entries()) {
  test(`${path}: public GET/HEAD, CORS, ETag, empty 304, preflight and /api alias`, async (t) => {
    const { base, gateCalls } = await serve(t);
    const headers = {
      Origin: CANONICAL_ORIGIN,
      Authorization: "Bearer synthetic-must-not-echo",
    };
    const get = await fetch(base + path, { headers });
    assert.equal(get.status, 200);
    const body = await get.text();
    assert.equal(
      body,
      JSON.stringify(
        index === 0
          ? buildA2aDiscovery(key).agentCard
          : buildA2aDiscovery(key).jwks,
      ),
    );
    assert.ok(!body.includes("synthetic-must-not-echo"));
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const common = (response: Response) => {
      assert.equal(response.headers.get("etag"), etag);
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=3600",
      );
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(
        response.headers.get("access-control-allow-methods"),
        "GET, HEAD, OPTIONS",
      );
      assert.ok(
        response.headers
          .get("access-control-expose-headers")
          ?.split(/,\s*/)
          .includes("ETag"),
      );
      assert.equal(
        response.headers.has("access-control-allow-credentials"),
        false,
      );
      assert.equal(response.headers.has("www-authenticate"), false);
      assert.equal(response.headers.get("location"), null);
    };
    common(get);
    for (const method of ["GET", "HEAD"]) {
      const normal = await fetch(base + path, { method, headers });
      assert.equal(normal.status, 200);
      common(normal);
      assert.equal(
        normal.headers.get("content-type"),
        `${index === 0 ? "application/json" : "application/jwk-set+json"}; charset=utf-8`,
      );
      assert.equal(
        normal.headers.get("content-length"),
        String(Buffer.byteLength(body)),
      );
      assert.equal(await normal.text(), method === "HEAD" ? "" : body);
      for (const validator of [etag, `W/${etag}`, `"old", ${etag}`, "*"]) {
        const cached = await fetch(base + path, {
          method,
          headers: { ...headers, "If-None-Match": validator },
        });
        assert.equal(cached.status, 304);
        common(cached);
        assert.equal(await cached.text(), "");
      }
    }
    const changed = await fetch(base + path, {
      headers: { "If-None-Match": '"old"' },
    });
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), body);
    const alias = await fetch(base + "/api" + path, { headers });
    assert.equal(alias.status, 200);
    common(alias);
    assert.equal(await alias.text(), body);
    const options = await fetch(base + path, {
      method: "OPTIONS",
      headers: {
        Origin: "https://untrusted.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, If-None-Match",
      },
      body: "invalid JSON",
    });
    assert.equal(options.status, 200);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    assert.equal(
      options.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
    assert.ok(
      options.headers.get("access-control-expose-headers")?.includes("ETag"),
    );
    assert.equal(gateCalls(), 0);
  });
}
