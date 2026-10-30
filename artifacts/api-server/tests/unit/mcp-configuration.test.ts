import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import express from "express";
import { registerMcpServerCardRoute } from "../../src/routes/mcp-server-card";
import { registerMachineMatrixRoutes } from "../../src/routes/machine-matrix";
import { mcpToolDefinitions } from "../../src/routes/mcp";
import { mcpToolPrices } from "../../src/lib/mcp-pricing";
import { mcpDiscoveryManifest } from "../../src/lib/mcp-discovery-manifest";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";

const matrixDirectory = resolve(process.cwd(), "../../.well-known");
type MatrixSnapshot = {
  version: string;
  mcp: { capabilities: { tools: { count: number } } };
  tools: { name: string; price_sats: number; payment_required: boolean }[];
};

function loadMatrixSnapshot(): MatrixSnapshot {
  return JSON.parse(
    readFileSync(resolve(matrixDirectory, "mcp-configuration.json"), "utf8"),
  );
}

function assertMatrixMatchesRuntime(snapshot: MatrixSnapshot): void {
  const runtime = mcpDiscoveryManifest;
  assert.equal(runtime.tools.length, 16);
  assert.equal(snapshot.version, runtime.version, "release version drift");
  assert.equal(
    snapshot.version,
    JSON.parse(
      readFileSync(resolve(process.cwd(), "../../package.json"), "utf8"),
    ).version,
    "repository release version drift",
  );
  assert.equal(snapshot.tools.length, runtime.tools.length, "tool count drift");
  assert.equal(
    snapshot.mcp.capabilities.tools.count,
    runtime.mcp.capabilities.tools.count,
    "advertised tool count drift",
  );
  assert.equal(
    new Set(snapshot.tools.map((tool) => tool.name)).size,
    snapshot.tools.length,
    "duplicate tool names",
  );
  const contract = (tools: MatrixSnapshot["tools"]) =>
    tools
      .map(({ name, price_sats, payment_required }) => ({
        name,
        price_sats,
        payment_required,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    contract(snapshot.tools),
    contract(runtime.tools),
    "canonical names, base prices or payment flags drift",
  );
  assert.equal(
    snapshot.tools.filter((tool) => !tool.payment_required).length,
    2,
  );
}

test("static machine matrix strictly matches canonical runtime tools, counts, payment flags, prices and release", () => {
  assertMatrixMatchesRuntime(loadMatrixSnapshot());
});

test("static machine matrix regression rejects every protected snapshot field drifting", () => {
  const mutations: [string, (snapshot: MatrixSnapshot) => void][] = [
    [
      "release version",
      (snapshot) => {
        snapshot.version = "0.0.0";
      },
    ],
    [
      "advertised count",
      (snapshot) => {
        snapshot.mcp.capabilities.tools.count -= 1;
      },
    ],
    [
      "missing tool",
      (snapshot) => {
        snapshot.tools.pop();
      },
    ],
    [
      "extra tool",
      (snapshot) => {
        snapshot.tools.push({ ...snapshot.tools[0]! });
      },
    ],
    [
      "duplicate name",
      (snapshot) => {
        snapshot.tools[1]!.name = snapshot.tools[0]!.name;
      },
    ],
    [
      "renamed tool",
      (snapshot) => {
        snapshot.tools[0]!.name = "unregistered.tool";
      },
    ],
    [
      "base price",
      (snapshot) => {
        snapshot.tools[0]!.price_sats += 1;
      },
    ],
    [
      "paid flag",
      (snapshot) => {
        snapshot.tools[0]!.payment_required = false;
      },
    ],
    [
      "free flag",
      (snapshot) => {
        snapshot.tools.find(
          (tool) => tool.name === "stratigraphy.list",
        )!.payment_required = true;
      },
    ],
  ];
  for (const [field, mutate] of mutations) {
    const snapshot = loadMatrixSnapshot();
    mutate(snapshot);
    assert.throws(
      () => assertMatrixMatchesRuntime(snapshot),
      assert.AssertionError,
      field,
    );
  }
});

test("early static machine matrix route and API alias serve the exact checked snapshot without authentication", async () => {
  const app = express();
  app.use(apiRootAliases);
  registerMachineMatrixRoutes(app, matrixDirectory);
  app.use((_req, res) => {
    res.status(401).end();
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const prefix of ["", "/api"]) {
      const url = `${base}${prefix}/.well-known/mcp-configuration.json`;
      const response = await fetch(url, {
        headers: {
          Authorization: "L402 invalid:invalid",
          Origin: "https://agent.example",
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(
        response.headers.get("access-control-allow-credentials"),
        null,
      );
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/json/,
      );
      const snapshot = await response.json();
      assert.deepEqual(snapshot, loadMatrixSnapshot());
      assertMatrixMatchesRuntime(snapshot);
      assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
      assert.equal((await fetch(url, { method: "OPTIONS" })).status, 204);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const denied = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: "{invalid-json",
        });
        assert.equal(denied.status, 405, `${method} ${prefix}`);
        assert.equal(denied.headers.get("allow"), "GET, HEAD, OPTIONS");
      }
    }
    assert.equal(
      (await fetch(`${base}/.well-known/not-a-manifest.json`)).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

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
