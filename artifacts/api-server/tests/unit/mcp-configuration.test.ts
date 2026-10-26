import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { registerMcpServerCardRoute } from "../../src/routes/mcp-server-card";
import { mcpToolDefinitions } from "../../src/routes/mcp";
import { mcpToolPrices } from "../../src/lib/mcp-pricing";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";

test("public MCP configuration returns 200 and exactly 16 canonical tools without L402", async () => {
  const app = express();
  app.use(apiRootAliases);
  registerMcpServerCardRoute(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of [
      "/.well-known/mcp-configuration.json",
      "/api/.well-known/mcp-configuration.json",
      "/.well-known/mcp.json",
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/json/,
      );
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      const manifest = await response.json();
      assert.equal(manifest.tools.length, 16);
      assert.equal(manifest.mcp.capabilities.tools.count, 16);
      assert.deepEqual(
        manifest.tools.map((tool: { name: string }) => tool.name),
        mcpToolDefinitions.map((tool) => tool.name),
      );
      assert.equal(
        new Set(manifest.tools.map((tool: { name: string }) => tool.name)).size,
        16,
      );
      for (const tool of manifest.tools) {
        assert.equal(
          tool.price_sats,
          mcpToolPrices[tool.name as keyof typeof mcpToolPrices],
        );
        assert.equal(tool.payment_required, tool.price_sats > 0);
      }
      assert.equal(
        manifest.tools.filter(
          (tool: { payment_required: boolean }) => !tool.payment_required,
        ).length,
        2,
      );
      assert.match(manifest.pricing.requirement, /L402/);
      assert.equal(manifest.pricing.ai_treasury_yield.allocation_percent, 21);
      assert.equal(manifest.pricing.ai_treasury_yield.merchant_percent, 79);
      assert.equal(
        manifest.pricing.ai_treasury_yield.payout_mode,
        "ledger_only_no_automatic_disbursement",
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
