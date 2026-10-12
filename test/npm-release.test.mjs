import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [workspace, distribution, build, check, readme] = await Promise.all([
  readFile(new URL("package.json", root), "utf8").then(JSON.parse),
  readFile(new URL("npm/mcp-server/package.json", root), "utf8").then(JSON.parse),
  readFile(new URL("scripts/build-npm-release.mjs", root), "utf8"),
  readFile(new URL("scripts/check-npm-release.mjs", root), "utf8"),
  readFile(new URL("npm/mcp-server/README.md", root), "utf8"),
]);

test("npm release is public and versioned without publishing the private workspace", () => {
  assert.equal(workspace.private, true);
  assert.equal(distribution.private, undefined);
  assert.equal(distribution.name, "@bitcoin-stratigraphy/mcp-server");
  assert.equal(distribution.version, workspace.version);
  assert.deepEqual(distribution.files, ["dist/", "README.md", "LICENSE"]);
  assert.equal(distribution.publishConfig.access, "public");
  assert.equal(distribution.bin["bitcoin-stratigraphy-mcp-server"], "dist/cli.mjs");
  assert.ok(Object.values(distribution.dependencies).every((v) => !/workspace:|catalog:|file:/.test(v)));
});

test("npm metadata defines real formulas and honest settlement boundaries", () => {
  for (const phrase of [
    "Hal Finney Horizon tracker", "15 J/TH thermodynamic energy calculation",
    "Live L402 Satoshi settlement",
  ]) {
    assert.ok(distribution.description.includes(phrase), phrase);
    assert.ok(readme.includes(phrase), phrase);
  }
  assert.match(readme, /\$10,000,000 \/ btc_price_usd/);
  assert.match(readme, /network_hashrate_h_s \/ 10\^12/);
  assert.match(readme, /does not spend a client's wallet automatically/);
  assert.match(readme, /not update a running HTTP deployment/);
});

test("release build stages required runtime and never copies a customer license or workspace", () => {
  assert.match(build, /rm\(destination, \{ recursive: true, force: true \}\)/);
  assert.match(build, /stratigraphy_pipeline\.py/);
  assert.match(build, /LICENSE\.md/);
  assert.doesNotMatch(build, /cp\([^;]*acme_corp\.lic/);
  assert.match(check, /npm.*pack.*--dry-run/s);
  assert.match(check, /Unexpected packaged file/);
  assert.match(check, /Private, development, or unnecessary file/);
});
