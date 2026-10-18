// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "mcp-npm-smoke-"));
const databaseDirectory = await mkdtemp(path.join(tmpdir(), "mcp-npm-smoke-db-"));
const clusterDirectory = path.join(databaseDirectory, "data");
async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const { port: reserved } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return reserved;
}
function runDatabaseTool(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: databaseDirectory, LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout || result.error}`);
}
const port = await reservePort();
const databasePort = await reservePort();
let child;
let databaseStarted = false;
let output = "";
try {
  // Startup recovers the durable escrow ledger, so the runtime needs real
  // PostgreSQL. Provision a disposable loopback-only cluster with the packaged
  // schema; never point this fixture runtime at a workspace or production database.
  runDatabaseTool("initdb", [
    "-D", clusterDirectory, "-U", "fixture", "--auth=trust", "--locale=C", "-E", "UTF8", "--no-instructions", "--no-sync",
  ]);
  runDatabaseTool("pg_ctl", [
    "-D", clusterDirectory, "-l", path.join(databaseDirectory, "postgres.log"), "-w",
    "-o", `-c listen_addresses=127.0.0.1 -p ${databasePort} -k ${databaseDirectory}`, "start",
  ]);
  databaseStarted = true;
  const psql = ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "fixture", "-v", "ON_ERROR_STOP=1", "-q"];
  runDatabaseTool("psql", [...psql, "-d", "postgres", "-c", "CREATE DATABASE fixture"]);
  runDatabaseTool("psql", [
    ...psql, "-d", "fixture", "-f", path.join(root, "generated-artifacts/npm/mcp-server/dist/database.sql"),
  ]);
  await cp(path.join(root, "generated-artifacts/npm/mcp-server"), directory, { recursive: true });
  await mkdir(path.join(directory, "node_modules"));
  // Resolve only the declared external dependencies; no workspace packages or
  // ambient node_modules tree may rescue an incomplete distribution.
  for (const name of ["snarkjs", "poseidon-lite"]) {
    await symlink(await realpath(path.join(root, "node_modules", name)), path.join(directory, "node_modules", name));
  }
  // Block every outbound socket except the disposable loopback database before
  // importing the application. Fixture signing identities must never announce
  // a pretend node to real Nostr relays.
  const bootstrap = `import {Socket} from "node:net";const connect=Socket.prototype.connect;Socket.prototype.connect=function(...args){const [first,second]=args;const options=Array.isArray(first)?first[0]:first&&typeof first==="object"?first:{port:first,host:typeof second==="string"?second:"localhost"};if(Number(options?.port)===${databasePort}&&["127.0.0.1","localhost"].includes(options?.host??"localhost"))return connect.apply(this,args);queueMicrotask(()=>this.destroy(new Error("Offline npm smoke: outbound connections disabled")));return this;};await import("./dist/cli.mjs");`;
  child = spawn(process.execPath, ["--input-type=module", "--eval", bootstrap], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, HOME: directory, NODE_ENV: "production", PORT: String(port),
      SESSION_SECRET: "npm-runtime-fixture-session-not-a-real-secret",
      DATABASE_URL: `postgresql://fixture@127.0.0.1:${databasePort}/fixture`,
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
  assert.equal(body.result.tools.length, 16);
  const description = body.result.tools.find((tool) => tool.name === "stratigraphy.get").description;
  for (const phrase of ["Hal Finney Horizon tracker", "15 J/TH thermodynamic energy calculation", "Live L402 Satoshi settlement"]) {
    assert.ok(description.includes(phrase), phrase);
  }
  const genesisId = "ba4f25dd-7f16-420c-9264-a16f102fd5a6";
  const receipt = await fetch(`http://127.0.0.1:${port}/api/v1/escrow/genesis-receipt`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).create_response.escrow_id, genesisId);
  const stats = await fetch(`http://127.0.0.1:${port}/api/v1/escrow/stats`, { signal: AbortSignal.timeout(5000) });
  assert.equal(stats.status, 200);
  assert.deepEqual(await stats.json(), { verified_toll_sats: 24, settled_contracts: 1, genesis_escrow_id: genesisId });
  console.log(
    "Isolated npm HTTP runtime, 16-tool discovery and genesis escrow recovery passed; " +
      "outbound connections blocked except the disposable loopback database.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (databaseStarted) {
    spawnSync("pg_ctl", ["-D", clusterDirectory, "-m", "immediate", "-w", "stop"], {
      env: { PATH: process.env.PATH, HOME: databaseDirectory, LC_ALL: "C" },
      stdio: "ignore",
    });
  }
  await rm(directory, { recursive: true, force: true });
  await rm(databaseDirectory, { recursive: true, force: true });
}
