// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createMcpDirectoryManifest, registerMcpDirectoryRoutes } from "./mcp-directory";
import { registerPublicCors } from "../middleware/publicCors";
import { apiRootAliases } from "../middleware/apiRootAliases";

for (const clearingEnabled of [false, true]) {
test(`directory probes preserve POST gates (clearing mounted: ${clearingEnabled})`, async () => {
  const app = express();
  app.use(apiRootAliases);
  registerPublicCors(app);
  registerMcpDirectoryRoutes(app, clearingEnabled);
  let gateCalls = 0;
  app.use((_req, res) => {
    gateCalls++;
    res.status(402).json({ error: "Payment Required" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/health", "/health/", "/api/health"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal((await response.json() as { status: string }).status, "ok");
    }
    for (const path of ["/mcp", "/mcp/", "/api/mcp"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("www-authenticate"), null);
      const manifest = await response.json() as ReturnType<typeof createMcpDirectoryManifest>;
      assert.equal(manifest.toolCount, 19);
      assert.equal(manifest.enabledToolCount, clearingEnabled ? 19 : 17);
      assert.equal(manifest.capabilities.tools.length, 19);
      assert.equal(new Set(manifest.capabilities.tools.map((tool: { name: string }) => tool.name)).size, 19);
      assert.equal(manifest.capabilities.tools.filter((tool: { enabled: boolean }) => tool.enabled).length, clearingEnabled ? 19 : 17);
      assert.deepEqual(manifest.capabilities.tools.filter((tool: { enabled: boolean }) => !tool.enabled)
        .map((tool: { name: string }) => tool.name), clearingEnabled ? [] : ["clearing.create_contract", "clearing.settle_contract"]);
      assert.equal(manifest.productionClearingSettlementEnabled, false);
      assert.equal(manifest.productionClearingPayoutsEnabled, false);
      const head = await fetch(base + path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    for (const path of ["/health", "/mcp", "/api/mcp", "/.well-known/mcp/server-card.json"]) {
      const response = await fetch(base + path, {
        method: "OPTIONS",
        headers: {
          Origin: "https://directory.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
          "Content-Type": "application/json",
        },
        body: "invalid JSON must never reach parsing",
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.match(response.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    }
    assert.equal(gateCalls, 0);
    for (const path of ["/mcp", "/api/mcp", "/health"]) {
      // This test exercises routing only, never any core or clearing tool.
      const response = await fetch(base + path, { method: "POST" });
      assert.equal(response.status, 402);
    }
    assert.equal(gateCalls, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
}
