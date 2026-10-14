// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "generated-artifacts/npm/mcp-server");
const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
const template = JSON.parse(await readFile(path.join(root, "npm/mcp-server/package.json"), "utf8"));
assert.deepEqual(manifest, template, "Regenerate the release before publishing");
assert.equal(manifest.name, "@bitcoin-stratigraphy/mcp-server");
assert.equal(manifest.private, undefined);
assert.deepEqual(manifest.files, ["dist/", "README.md", "LICENSE"]);
assert.equal(manifest.version, JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version);
assert.ok(Object.values(manifest.dependencies).every((version) => !/workspace:|catalog:|file:/.test(version)));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: directory, encoding: "utf8",
});
assert.equal(packed.status, 0, packed.stderr);
const [result] = JSON.parse(packed.stdout);
for (const entry of result.files) {
  assert.ok(
    ["package.json", "README.md", "LICENSE"].includes(entry.path) || entry.path.startsWith("dist/"),
    `Unexpected packaged file: ${entry.path}`,
  );
  assert.doesNotMatch(
    entry.path,
    /(?:\.map$|\.r1cs$|\.lic$|\.sqlite(?:3)?(?:-|$)|\.env(?:\.|$)|__pycache__|\.pyc$|audit_trail|\.coverage|snapshot_\d|node_modules|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$))/,
    `Private, development, or unnecessary file: ${entry.path}`,
  );
}
const required = [
  "package.json", "README.md", "LICENSE", "dist/index.mjs", "dist/cli.mjs",
  "dist/database.sql",
  "dist/enterprise/stratigraphy_pipeline.py", "dist/enterprise/main.py",
  "dist/enterprise/requirements.txt", "dist/escrow-worker/routers/escrow_worker.py",
  "dist/zk/artifacts/telemetry.wasm", "dist/zk/artifacts/drift_js/drift.wasm",
];
for (const filename of required) assert.ok(result.files.some((entry) => entry.path === filename), filename);
assert.equal(await readFile(path.join(directory, "LICENSE"), "utf8"), await readFile(path.join(root, "LICENSE.md"), "utf8"));
const help = spawnSync(process.execPath, ["dist/cli.mjs", "--help"], { cwd: directory, encoding: "utf8" });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Streamable HTTP/);
const smoke = spawnSync(process.execPath, [path.join(root, "scripts/smoke-npm-release.mjs")], {
  cwd: root, stdio: "inherit", timeout: 30_000,
});
assert.equal(smoke.status, 0, "Isolated npm runtime smoke check failed");
console.log(`${result.name}@${result.version}: ${result.files.length} allowed files; ${result.size} compressed bytes. Pack dry-run and CLI smoke check passed.`);
