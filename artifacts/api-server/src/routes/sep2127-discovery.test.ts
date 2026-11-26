// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express from "express";
import {
  AI_CATALOG_MEDIA_TYPE,
  MCP_SERVER_CARD_MEDIA_TYPE,
  SEP2127_PATHS,
  buildSep2127Discovery,
} from "../lib/sep2127-discovery";
import {
  CANONICAL_ORIGIN,
  RELEASE_VERSION,
  canonicalUrl,
} from "../lib/public-site";
import {
  MCP_SERVER_INFO,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "../lib/mcp-stateless";
import { apiRootAliases } from "../middleware/apiRootAliases";
import { registerPublicCors } from "../middleware/publicCors";
import { registerMcpServerCardRoute } from "./mcp-server-card";
import { mcpToolDefinitions } from "./mcp";
import { registerToolIntegrityRoute } from "./tool-integrity";
import { registerSep2127DiscoveryRoutes } from "./sep2127-discovery";
import { registerA2aDiscoveryRoutes } from "./a2a-discovery";

async function serve(app: express.Express, t: TestContext) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("SEP-2127 card contains only static canonical connectivity and shared live versions", () => {
  const { serverCard } = buildSep2127Discovery();
  assert.deepEqual(
    Object.keys(serverCard).sort(),
    [
      "$schema",
      "name",
      "title",
      "version",
      "description",
      "websiteUrl",
      "remotes",
    ].sort(),
  );
  assert.equal(
    serverCard.$schema,
    "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  );
  assert.equal(serverCard.name, "com.bitcoinstratigraphy/mcp");
  assert.match(serverCard.name, /^[a-z0-9]+(?:\.[a-z0-9-]+)+\/[a-z0-9-]+$/);
  assert.equal(serverCard.title, "Bitcoin Stratigraphy MCP Server");
  assert.equal(
    serverCard.description,
    "Bitcoin L402 telemetry, OpenTimestamps notarization, and tamper-evident AI audit MCP server.",
  );
  assert.ok(serverCard.description.length <= 100);
  assert.equal(serverCard.version, MCP_SERVER_INFO.version);
  assert.equal(serverCard.version, RELEASE_VERSION);
  assert.equal(serverCard.websiteUrl, CANONICAL_ORIGIN);
  assert.deepEqual(serverCard.remotes, [
    {
      type: "streamable-http",
      url: canonicalUrl("/mcp"),
      supportedProtocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
    },
  ]);
  const url = new URL(serverCard.remotes[0]!.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, new URL(CANONICAL_ORIGIN).hostname);
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.ok(
    !/tools|resources|prompts|capabilities|credentials|token|localhost|127\.0\.0\.1|secret|private_key/i.test(
      JSON.stringify(serverCard),
    ),
  );
  // Returned arrays are detached: consumers cannot change shared negotiation.
  serverCard.remotes[0]!.supportedProtocolVersions.length = 0;
  assert.deepEqual(
    buildSep2127Discovery().serverCard.remotes[0]!.supportedProtocolVersions,
    MCP_SUPPORTED_PROTOCOL_VERSIONS,
  );
});

test("AI Catalog has URL-only MCP and A2A card entries with canonical did:web and urn:air identifiers", () => {
  const { catalog } = buildSep2127Discovery();
  const domain = new URL(CANONICAL_ORIGIN).hostname;
  assert.deepEqual(catalog, {
    specVersion: "1.0",
    host: {
      displayName: "Bitcoin Stratigraphy",
      identifier: `did:web:${domain}`,
    },
    entries: [
      {
        identifier: `urn:air:${domain}:mcp:bitcoin-stratigraphy`,
        type: MCP_SERVER_CARD_MEDIA_TYPE,
        url: canonicalUrl("/mcp/server-card"),
      },
      {
        identifier: `urn:air:${domain}:a2a:bitcoin-stratigraphy`,
        type: "application/a2a-agent-card+json",
        url: canonicalUrl("/.well-known/agent-card.json"),
      },
    ],
  });
  assert.match(catalog.host.identifier, /^did:web:[a-z0-9.-]+$/);
  assert.match(catalog.entries[0]!.identifier, /^urn:air:/);
  assert.equal("data" in catalog.entries[0]!, false);
});

for (const path of SEP2127_PATHS) {
  test(`${path}: GET/HEAD, exact media type, public CORS, deterministic ETag, 304 and preflight`, async (t) => {
    const app = express();
    app.use(apiRootAliases);
    registerPublicCors(app);
    registerSep2127DiscoveryRoutes(app);
    let gateCalls = 0;
    app.use(express.json());
    app.use((_req, res) => {
      gateCalls++;
      res.status(402).json({ error: "Synthetic payment gate" });
    });
    const base = await serve(app, t);
    const headers = {
      Origin: CANONICAL_ORIGIN,
      Authorization: "Bearer synthetic-never-echo",
    };
    const response = await fetch(base + path, { headers, redirect: "manual" });
    assert.equal(response.status, 200);
    const mediaType =
      path === SEP2127_PATHS[0]
        ? AI_CATALOG_MEDIA_TYPE
        : MCP_SERVER_CARD_MEDIA_TYPE;
    const body = await response.text();
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    const common = (r: Response) => {
      assert.equal(r.headers.get("access-control-allow-origin"), "*");
      assert.equal(r.headers.has("access-control-allow-credentials"), false);
      assert.equal(
        r.headers.get("access-control-allow-methods"),
        "GET, HEAD, OPTIONS",
      );
      assert.ok(
        r.headers
          .get("access-control-expose-headers")
          ?.split(/,\s*/)
          .includes("ETag"),
      );
      assert.equal(r.headers.get("cache-control"), "public, max-age=3600");
      assert.equal(r.headers.get("etag"), etag);
    };
    common(response);
    assert.equal(
      response.headers.get("content-type"),
      `${mediaType}; charset=utf-8`,
    );
    assert.match(etag, /^"[0-9a-f]{64}"$/);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.has("www-authenticate"), false);
    assert.ok(!body.includes("synthetic-never-echo"));
    const documents = buildSep2127Discovery();
    assert.equal(
      body,
      JSON.stringify(
        path === SEP2127_PATHS[0] ? documents.catalog : documents.serverCard,
      ),
    );
    for (const method of ["GET", "HEAD"]) {
      const normal = await fetch(base + path, { method, headers });
      assert.equal(normal.status, 200);
      common(normal);
      assert.equal(
        normal.headers.get("content-type"),
        `${mediaType}; charset=utf-8`,
      );
      assert.equal(
        normal.headers.get("content-length"),
        String(Buffer.byteLength(body)),
      );
      assert.equal(await normal.text(), method === "HEAD" ? "" : body);
      for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
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
      headers: { "If-None-Match": '"not-the-current-document"' },
    });
    assert.equal(changed.status, 200);
    assert.equal(await changed.text(), body);
    const alias = await fetch(base + "/api" + path, { headers });
    assert.equal(alias.status, 200);
    common(alias);
    assert.equal(await alias.text(), body);
    if (path !== SEP2127_PATHS[0]) {
      const other = await fetch(
        base + (path === "/server-card" ? "/mcp/server-card" : "/server-card"),
        { headers },
      );
      assert.equal(await other.text(), body);
      for (const key of response.headers.keys())
        if (key !== "date")
          assert.equal(other.headers.get(key), response.headers.get(key), key);
    }
    const options = await fetch(base + path, {
      method: "OPTIONS",
      headers: {
        ...headers,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "If-None-Match, Authorization",
      },
      body: "invalid JSON must not reach parsing",
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
    assert.equal(gateCalls, 0);
  });
}

test("legacy discovery, integrity and connector payloads/headers are unchanged by SEP-2127 registration", async (t) => {
  const app = express();
  app.use(apiRootAliases);
  registerPublicCors(app);
  registerMcpServerCardRoute(app);
  const integrityKey = generateKeyPairSync("ed25519").privateKey;
  registerToolIntegrityRoute(
    app,
    mcpToolDefinitions,
    integrityKey,
  );
  const base = await serve(app, t);
  const paths = [
    "/.well-known/mcp.json",
    "/.well-known/mcp-configuration.json",
    "/.well-known/mcp/server-card.json",
    "/.well-known/mcp/connector.json",
    "/.well-known/glama-mcp-connector.json",
    "/.well-known/glama.json",
    "/.well-known/integrity.json",
  ];
  const snapshots = [];
  for (const path of paths) {
    const response = await fetch(base + path, {
      headers: { Origin: CANONICAL_ORIGIN },
    });
    assert.equal(response.status, 200, path);
    snapshots.push({
      body: await response.text(),
      headers: Object.fromEntries(
        [...response.headers].filter(([key]) => key !== "date"),
      ),
    });
  }
  registerSep2127DiscoveryRoutes(app);
  registerA2aDiscoveryRoutes(app, integrityKey);
  for (const [index, path] of paths.entries()) {
    const response = await fetch(base + path, {
      headers: { Origin: CANONICAL_ORIGIN },
    });
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), snapshots[index]!.body, path);
    assert.deepEqual(
      Object.fromEntries(
        [...response.headers].filter(([key]) => key !== "date"),
      ),
      snapshots[index]!.headers,
      path,
    );
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
});
