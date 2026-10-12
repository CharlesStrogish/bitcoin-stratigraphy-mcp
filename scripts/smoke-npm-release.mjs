// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "mcp-npm-smoke-"));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let child;
let output = "";
try {
  await cp(path.join(root, "generated-artifacts/npm/mcp-server"), directory, { recursive: true });
  await mkdir(path.join(directory, "node_modules"));
  // Resolve only the declared external dependencies; no workspace packages or
  // ambient node_modules tree may rescue an incomplete distribution.
  for (const name of ["snarkjs", "poseidon-lite"]) {
    await symlink(await realpath(path.join(root, "node_modules", name)), path.join(directory, "node_modules", name));
  }
  // Block every outbound socket before importing the application. Fixture
  // signing identities must never announce a pretend node to real Nostr relays.
  const bootstrap = 'import {Socket} from "node:net";Socket.prototype.connect=function(){queueMicrotask(()=>this.destroy(new Error("Offline npm smoke: outbound connections disabled")));return this;};await import("./dist/cli.mjs");';
  child = spawn(process.execPath, ["--input-type=module", "--eval", bootstrap], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, HOME: directory, NODE_ENV: "production", PORT: String(port),
      SESSION_SECRET: "npm-runtime-fixture-session-not-a-real-secret",
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:9/fixture",
      NOSTR_PRIVATE_KEY: "1".padStart(64, "0"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Isolated package exited: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Isolated runtime never became healthy: ${output}`);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.tools.length, 15);
  const description = body.result.tools.find((tool) => tool.name === "stratigraphy.get").description;
  for (const phrase of ["Hal Finney Horizon tracker", "15 J/TH thermodynamic energy calculation", "Live L402 Satoshi settlement"]) {
    assert.ok(description.includes(phrase), phrase);
  }
  console.log("Isolated npm HTTP runtime and 15-tool discovery passed; all outbound connections blocked.");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await rm(directory, { recursive: true, force: true });
}
