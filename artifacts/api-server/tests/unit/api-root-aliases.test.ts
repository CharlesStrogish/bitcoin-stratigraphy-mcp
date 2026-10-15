import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { readOpenApiContract } from "../../src/lib/openapi-contract";
import {
  apiRootAliases,
  rewriteApiRootAlias,
} from "../../src/middleware/apiRootAliases";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

test("maps /api aliases of root documents and the MCP endpoint to their root routes", () => {
  for (const [alias, root] of [
    ["/api/openapi.json", "/openapi.json"],
    ["/api/mcp", "/mcp"],
    ["/api/mcp/", "/mcp/"],
    ["/api/mcp?session=1", "/mcp?session=1"],
    ["/api/.well-known/nostr.json?name=_", "/.well-known/nostr.json?name=_"],
    [
      "/api/.well-known/mcp/server-card.json",
      "/.well-known/mcp/server-card.json",
    ],
    ["/API/MCP", "/MCP"],
  ]) {
    assert.equal(rewriteApiRootAlias(alias!), root, alias);
  }
  for (const url of [
    "/api",
    "/api/",
    "/api/docs",
    "/api/v1/stratigraphy",
    "/api/mcp/tools",
    "/api/mcpx",
    "/api/openapi.jsonx",
    "/api/.well-known/",
    "/apix/mcp",
    "/mcp",
    "/openapi.json",
  ]) {
    assert.equal(rewriteApiRootAlias(url), url, url);
  }
});

test("every OpenAPI path served from the origin also resolves under the /api server", () => {
  type Servers = Array<{ url: string }>;
  const contract = readOpenApiContract() as {
    servers: Servers;
    paths: Record<string, Record<string, unknown>>;
  };
  const rootPaths = new Set<string>();
  for (const [path, item] of Object.entries(contract.paths)) {
    const pathServers = item.servers as Servers | undefined;
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      // Operation servers override path servers, which override the root.
      const servers = (
        (operation as { servers?: Servers }).servers ??
        pathServers ??
        contract.servers
      ).map(({ url }) => url);
      if (servers.every((url) => !url.endsWith("/api"))) rootPaths.add(path);
    }
  }
  assert.ok(rootPaths.has("/mcp") && rootPaths.has("/.well-known/nostr.json"));
  for (const path of rootPaths) {
    assert.equal(rewriteApiRootAlias(`/api${path}`), path, path);
  }
});

test("an alias reaches the root route through the same middleware and keeps its original URL", async () => {
  const app = express();
  app.use(apiRootAliases);
  const seen: string[] = [];
  app.use((req, _res, next) => {
    seen.push(req.path);
    next();
  });
  app.get("/.well-known/nostr.json", (req, res) => {
    res.json({ path: req.path, originalUrl: req.originalUrl });
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const alias = await fetch(`${baseUrl}/api/.well-known/nostr.json?name=_`);
    assert.equal(alias.status, 200);
    assert.deepEqual(await alias.json(), {
      path: "/.well-known/nostr.json",
      originalUrl: "/api/.well-known/nostr.json?name=_",
    });
    assert.deepEqual(seen, ["/.well-known/nostr.json"]);
    assert.equal((await fetch(`${baseUrl}/api/v1/unknown`)).status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
