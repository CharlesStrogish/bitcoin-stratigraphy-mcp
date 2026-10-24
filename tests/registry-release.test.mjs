import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const { parse } = require("yaml");
const root = new URL("../", import.meta.url);
const [smithery, glama, pkg, readme, npmPackage] = await Promise.all([
  readFile(new URL("smithery.yaml", root), "utf8").then(parse),
  readFile(new URL("glama.json", root), "utf8").then(JSON.parse),
  readFile(new URL("package.json", root), "utf8").then(JSON.parse),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("npm/mcp-server/package.json", root), "utf8").then(JSON.parse),
]);

test("registry manifests agree on the live remote MCP endpoint and release", () => {
  assert.equal(pkg.mcpName, "crstrogish/bitcoin-stratigraphy");
  assert.equal(smithery.version, pkg.version);
  assert.equal(pkg.version, npmPackage.version);
  assert.equal(npmPackage.homepage, "https://bitcoinstratigraphy.com");
  assert.match(npmPackage.author, /^Charles R\. Strogish\b/);
  assert.equal(glama.version, smithery.version);
  assert.equal(glama.toolCount, 16);
  assert.equal(smithery.transport.type, "streamable-http");
  assert.equal(
    smithery.transport.url,
    "https://bitcoinstratigraphy.com/mcp",
  );
  assert.equal(smithery.connection.url, smithery.transport.url);
  assert.equal(glama.url, smithery.transport.url);
  assert.equal(glama.description, smithery.description);
  for (const phrase of [
    "16 L402-gated tools",
    "OpenTimestamps AI Notary Hub",
    "LangChain/LlamaIndex Native",
    "100-call Macro-Macaroons",
    "Free Sandbox available",
    "Hal Finney Horizon tracker",
    "15 J/TH thermodynamic energy calculation",
    "Live L402 Satoshi settlement",
  ]) {
    assert.ok(smithery.description.includes(phrase), phrase);
  }
});

test("registry sandbox and notarization pricing claims match the release", () => {
  for (const registry of [smithery, glama]) {
    assert.deepEqual(registry.pricing.freeDiscovery.tools, [
      "stratigraphy.list",
      "proof.list",
    ]);
    assert.equal(registry.pricing.freeDiscovery.priceSats, 0);
    const pricing = registry.pricing.currentPublishedL402;
    assert.equal(pricing["proof.listSats"], 0);
    assert.equal(pricing.notarizationBatchCalls, 100);
    assert.equal(pricing.notarizationCallSats, 250);
    assert.equal(
      pricing.notarizationBatchSats,
      pricing.notarizationBatchCalls * pricing.notarizationCallSats,
    );
  }
});

test("README prominently links native frameworks and all three readiness badges", () => {
  assert.match(
    readme.slice(0, 2200),
    new RegExp(`v${pkg.version.replaceAll(".", "\\.")} — 16 Canonical Tools`),
  );
  assert.match(readme, /\]\(cookbooks\/frameworks\/\)/);
  for (const badge of [
    "LangChain Ready",
    "LlamaIndex Ready",
    "OpenTimestamps Integrated",
  ]) {
    assert.ok(readme.includes(`[![${badge}]`), badge);
  }
  assert.doesNotMatch(readme, /14 production tools/);
});
