// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { cp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "generated-artifacts/npm/mcp-server");
const template = path.join(root, "npm/mcp-server");
const manifest = JSON.parse(await readFile(path.join(template, "package.json"), "utf8"));
const workspace = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (manifest.version !== workspace.version) throw new Error("Npm/workspace release versions differ");
const build = spawnSync("pnpm", ["--filter", "@workspace/api-server", "run", "build"], {
  cwd: root, stdio: "inherit",
});
if (build.status !== 0) throw new Error("API runtime build failed");
// Always regenerate from explicit public source/runtime allowlists, never from
// the live workspace, a license file, or a dirty previous release directory.
await rm(destination, { recursive: true, force: true });
await mkdir(path.join(destination, "dist"), { recursive: true });
await writeFile(path.join(destination, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await cp(path.join(template, "README.md"), path.join(destination, "README.md"));
await cp(path.join(root, "LICENSE.md"), path.join(destination, "LICENSE"));
await cp(path.join(template, "cli.mjs"), path.join(destination, "dist/cli.mjs"));
await chmod(path.join(destination, "dist/cli.mjs"), 0o755);
const runtime = path.join(root, "artifacts/api-server/dist");
for (const filename of [
  "index.mjs", "pino-file.mjs", "pino-pretty.mjs", "pino-worker.mjs", "thread-stream-worker.mjs",
]) await cp(path.join(runtime, filename), path.join(destination, "dist", filename));
for (const folder of ["escrow-worker", "audit-worker", "public"]) {
  await cp(path.join(runtime, folder), path.join(destination, "dist", folder), { recursive: true });
}
// Proving/verifying material actually referenced by the runtime; no R1CS,
// witness-generation scripts, tests, or linked development source maps.
for (const filename of [
  "telemetry.wasm", "telemetry_final.zkey", "verification_key.json", "warmup_proof.json",
  "drift_js/drift.wasm", "drift_final.zkey", "drift_verification_key.json",
]) {
  const target = path.join(destination, "dist/zk/artifacts", filename);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(runtime, "zk/artifacts", filename), target);
}
const enterprise = path.join(destination, "dist/enterprise");
const exportedSchema = spawnSync("pnpm", [
  "--filter", "@workspace/db", "exec", "drizzle-kit", "export",
  "--dialect=postgresql", "--schema=./src/schema/index.ts",
], { cwd: root, encoding: "utf8" });
if (exportedSchema.status !== 0) throw new Error("Could not export the database schema");
const sqlStart = exportedSchema.stdout.search(/^CREATE (?:TABLE|TYPE|SCHEMA|SEQUENCE|EXTENSION)/m);
if (sqlStart < 0) throw new Error("Database schema export did not contain SQL");
await writeFile(path.join(destination, "dist/database.sql"), exportedSchema.stdout.slice(sqlStart));
await mkdir(enterprise, { recursive: true });
for (const filename of [
  "main.py", "license_verifier.py", "agent_api.py", "stratigraphy_pipeline.py",
  "stratigraphy_bridge.py", "stratigraphy_tools.py", "provenance_anchor.py",
  "provenance_storage.py", "provenance_upgrade.py", "provenance_routes.py",
]) await cp(path.join(root, filename), path.join(enterprise, filename));
const sdk = path.join(enterprise, "bitcoin_stratigraphy_enterprise");
await mkdir(sdk, { recursive: true });
for (const filename of ["__init__.py", "audit_verifier_ots.py"]) {
  await cp(path.join(root, "sdk/python/bitcoin_stratigraphy_enterprise", filename), path.join(sdk, filename));
}
await writeFile(path.join(enterprise, "requirements.txt"), [
  "cryptography>=50.0.2", "fastapi>=0.143.0", "fastapi-mcp>=0.4.0",
  "httpx==0.28.1", "opentimestamps>=0.4.5", "opentimestamps-client>=0.7.2",
  "pydantic>=2.11,<3", "replit-object-storage>=1.0.2", "google-api-core>=2.33.0",
  "uvicorn>=0.54.0", "",
].join("\n"));
console.log(`Prepared ${manifest.name}@${manifest.version} in ${destination}`);
