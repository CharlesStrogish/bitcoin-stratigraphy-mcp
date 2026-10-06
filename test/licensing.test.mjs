import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const copyright = "Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.";
const terms = "Dual-licensed under AGPLv3 and Commercial terms.";
const skip = new Set(["node_modules", "dist", "build", "__pycache__", ".venv"]);

function sourceFiles(dir) {
  return readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((entry) => {
    if (skip.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(py|ts|js|tsx|jsx)$/.test(entry.name) ? [path] : [];
  });
}

test("AGPL text is complete and unmodified, with matching packaged and public copies", () => {
  const license = read("LICENSE.md");
  assert.ok(license.startsWith(`${copyright}\nThis software is dual-licensed.`));
  const canonical = license.slice(license.indexOf("GNU AFFERO GENERAL PUBLIC LICENSE"));
  // SPDX license-list-data's complete AGPL-3.0-only.txt, including application guidance.
  assert.equal(createHash("sha256").update(canonical).digest("hex"),
    "d8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee");
  for (const path of [
    "sdk/python/LICENSE.md", "sdk/typescript/LICENSE.md", "plugins/elizaos/LICENSE.md",
    "artifacts/bitcoin-stratigraphy-dashboard/public/LICENSE.md",
  ]) assert.equal(read(path), license, path);
  assert.equal(read("artifacts/bitcoin-stratigraphy-dashboard/public/SECURITY.md"), read("SECURITY.md"));
});

test("all active SDK, cookbook and server route sources have correctly positioned headers", () => {
  const paths = ["sdk", "cookbooks", "artifacts/api-server/src/routes"].flatMap(sourceFiles);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    const lines = read(path).split(/\r?\n/);
    let position = lines[0].startsWith("#!") ? 1 : 0;
    if (path.endsWith(".py")) {
      for (let i = 0; i < Math.min(2, lines.length); i++) {
        if (/^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/.test(lines[i])) position = Math.max(position, i + 1);
      }
    }
    const prefix = path.endsWith(".py") ? "#" : "//";
    assert.equal(lines[position], `${prefix} ${copyright}`, path);
    assert.equal(lines[position + 1], `${prefix} ${terms}`, path);
    assert.equal(lines.filter((line) => line === `${prefix} ${copyright}`).length, 1, path);
  }
});

test("publishable package metadata and license file lists reflect dual licensing", () => {
  for (const path of ["package.json", "sdk/typescript/package.json", "plugins/elizaos/package.json"]) {
    const pkg = JSON.parse(read(path));
    assert.equal(pkg.license, "(AGPL-3.0-only OR LicenseRef-Commercial)", path);
    if (pkg.files) assert.ok(pkg.files.includes("LICENSE.md"), path);
  }
  const python = read("sdk/python/pyproject.toml");
  assert.match(python, /license = "AGPL-3.0-only OR LicenseRef-Commercial"/);
  assert.match(python, /license-files = \["LICENSE\.md"\]/);
  const exporter = read("scripts/stage-standalone-github-repo.mjs");
  assert.ok(exporter.includes('copy("LICENSE.md")'));
  assert.ok(exporter.includes('copy("SECURITY.md")'));
});

test("licensing is documented and reachable on the standard page", () => {
  assert.ok(read("README.md").includes("## Licensing, IP & Enterprise Terms"));
  assert.ok(read("README.md").includes("Created & Architected by Charles R. Strogish."));
  const standard = read("artifacts/bitcoin-stratigraphy-dashboard/src/pages/standard.tsx");
  assert.ok(standard.includes('id="licensing"'));
  assert.ok(standard.includes("Licensing, IP &amp; Enterprise Terms"));
  assert.ok(standard.includes('["licensing", "Licensing & IP"]'));
  assert.ok(standard.includes("`${BASE}LICENSE.md`"));
  assert.ok(standard.includes("`${BASE}SECURITY.md`"));
});
