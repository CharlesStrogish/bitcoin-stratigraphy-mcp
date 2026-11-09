import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const [glama, pkg, readme, npmPackage] = await Promise.all([
  readFile(new URL("glama.json", root), "utf8").then(JSON.parse),
  readFile(new URL("package.json", root), "utf8").then(JSON.parse),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("npm/mcp-server/package.json", root), "utf8").then(JSON.parse),
]);

test("registry manifests agree on the live remote MCP endpoint and release", () => {
  assert.equal(pkg.mcpName, "com.bitcoinstratigraphy/bitcoin-stratigraphy");
  assert.equal(npmPackage.mcpName, pkg.mcpName);
  assert.equal(pkg.version, npmPackage.version);
  assert.equal(npmPackage.homepage, "https://bitcoinstratigraphy.com");
  assert.match(npmPackage.author, /^Charles R\. Strogish\b/);
  assert.equal(glama.version, pkg.version);
  assert.equal(glama.toolCount, 16);
  assert.equal(glama.transport, "streamable-http");
  assert.equal(glama.url, "https://bitcoinstratigraphy.com/mcp");
  for (const phrase of [
    "19 Fiduciary-grade MCP Tools at full platform capacity across six namespaces",
    "14 paid L402 tools and 2 free sandbox tools",
    "Production clearing settlement and payouts remain disabled",
    "OpenTimestamps AI Notary Hub",
    "LangChain/LlamaIndex Native",
    "100-call Macro-Macaroons",
    "Free Sandbox available",
    "Hal Finney Horizon tracker",
    "15 J/TH thermodynamic energy calculation",
    "Live L402 Satoshi settlement",
  ]) {
    assert.ok(glama.description.includes(phrase), phrase);
  }
});

test("registry sandbox and notarization pricing claims match the release", () => {
  for (const registry of [glama]) {
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
    readme.split("\n").slice(0, 80).join("\n"),
    new RegExp(`v${pkg.version.replaceAll(".", "\\.")} — 19 Fiduciary-grade MCP Tools`),
  );
  assert.match(
    readme,
    /\]\(https:\/\/github\.com\/CharlesStrogish\/bitcoin-stratigraphy-mcp\/tree\/main\/cookbooks\/frameworks\)/,
  );
  for (const badge of [
    "LangChain Ready",
    "LlamaIndex Ready",
    "OpenTimestamps Integrated",
  ]) {
    assert.ok(readme.includes(`[![${badge}]`), badge);
  }
  assert.doesNotMatch(readme, /14 production tools/);
});
