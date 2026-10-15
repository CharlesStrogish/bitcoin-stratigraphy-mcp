// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
// Measures API cold-start readiness against a disposable loopback PostgreSQL.
//
//   node scripts/measure-api-startup.mjs [--runs 5] [--bundle <path to index.mjs>]
//     [--verbose] [--linger <ms>]   (--linger keeps each server up to log background phases)
//
// The bundle runs with the production flags from a temporary working directory,
// with every outbound socket blocked except the disposable database. It never
// touches the workspace or production DATABASE_URL, nor the workspace .data/
// directory. Reported times are milliseconds from process spawn:
//   port      TCP port accepts connections (the proxy stops returning 500s)
//   health    GET /api/healthz returns 200
//   mcp.json  GET /.well-known/mcp.json returns 200
//   escrow    GET /api/v1/escrow/stats returns the recovered 24-sat ledger
//   app       the server's "Server listening" log line (application attached)
// "failures" counts non-200 responses received after the port opened.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    bundle: { type: "string", default: "artifacts/api-server/dist/index.mjs" },
    verbose: { type: "boolean", default: false },
    linger: { type: "string", default: "0" },
    "cpu-prof-dir": { type: "string" },
  },
});
const runs = Number(values.runs);
assert.ok(
  Number.isInteger(runs) && runs > 0,
  "--runs must be a positive integer",
);
const bundle = path.resolve(root, values.bundle);
const genesisId = "ba4f25dd-7f16-420c-9264-a16f102fd5a6";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function runTool(command, args, home) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, LC_ALL: "C" },
  });
  assert.equal(
    result.status,
    0,
    `${command} failed: ${result.stderr || result.stdout || result.error}`,
  );
  return result.stdout;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// Waits for the port, then keeps one request in flight until it succeeds.
// Failures after the port opened are counted: they are what clients would see.
async function firstSuccess(
  port,
  pathname,
  startedAt,
  accept,
  deadline,
  stats,
) {
  while (!(await portOpen(port))) {
    if (performance.now() > deadline || stats.exited) return undefined;
    await sleep(10);
  }
  while (performance.now() < deadline && !stats.exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(deadline - performance.now())),
        ),
      });
      const body = await response.text();
      if (response.ok && accept(body)) return performance.now() - startedAt;
      stats.failures.push(
        `${pathname} ${response.status} ${body.slice(0, 120)}`,
      );
    } catch (error) {
      stats.failures.push(`${pathname} ${error.cause?.code ?? error.name}`);
    }
    await sleep(25);
  }
  return undefined;
}

async function measure({ port, databasePort, databaseUrl, home }) {
  const workdir = await mkdtemp(path.join(tmpdir(), "api-startup-run-"));
  // Same outbound guard as the npm runtime smoke: fixture identities must never
  // reach real relays, calendars or wallets.
  const bootstrap = `import {Socket} from "node:net";const connect=Socket.prototype.connect;Socket.prototype.connect=function(...args){const [first,second]=args;const options=Array.isArray(first)?first[0]:first&&typeof first==="object"?first:{port:first,host:typeof second==="string"?second:"localhost"};if(Number(options?.port)===${databasePort}&&["127.0.0.1","localhost"].includes(options?.host??"localhost"))return connect.apply(this,args);queueMicrotask(()=>this.destroy(new Error("Startup measurement: outbound connections disabled")));return this;};await import(${JSON.stringify(pathToFileURL(bundle).href)});`;
  const spawnedAtEpoch = Date.now();
  const startedAt = performance.now();
  const profile = values["cpu-prof-dir"]
    ? ["--cpu-prof", `--cpu-prof-dir=${path.resolve(values["cpu-prof-dir"])}`]
    : [];
  const child = spawn(
    process.execPath,
    [
      ...profile,
      "--enable-source-maps",
      "--input-type=module",
      "--eval",
      bootstrap,
    ],
    {
      cwd: workdir,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        NODE_ENV: "production",
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: "startup-measurement-session-not-a-real-secret",
        NOSTR_PRIVATE_KEY: "1".padStart(64, "0"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  const stats = { failures: [], exited: false };
  const deadline = startedAt + 60_000;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  void exited.then(() => {
    stats.exited = true;
  });
  try {
    const portProbe = (async () => {
      while (performance.now() < deadline && child.exitCode === null) {
        if (await portOpen(port)) return performance.now() - startedAt;
        await sleep(10);
      }
      return undefined;
    })();
    const [portMs, healthMs, discoveryMs, escrowMs] = await Promise.all([
      portProbe,
      firstSuccess(
        port,
        "/api/healthz",
        startedAt,
        () => true,
        deadline,
        stats,
      ),
      firstSuccess(
        port,
        "/.well-known/mcp.json",
        startedAt,
        () => true,
        deadline,
        stats,
      ),
      firstSuccess(
        port,
        "/api/v1/escrow/stats",
        startedAt,
        (body) => {
          const ledger = JSON.parse(body);
          // A recovered ledger is the only acceptable 200; never a zero counter.
          assert.deepEqual(ledger, {
            verified_toll_sats: 24,
            settled_contracts: 1,
            genesis_escrow_id: genesisId,
          });
          return true;
        },
        deadline,
        stats,
      ),
    ]);
    if (child.exitCode !== null)
      throw new Error(`API exited during startup:\n${output}`);
    if ([portMs, healthMs, discoveryMs, escrowMs].includes(undefined)) {
      throw new Error(
        `API never became ready:\n${stats.failures.slice(-5).join("\n")}\n${output.slice(-4000)}`,
      );
    }
    const receipt = await fetch(
      `http://127.0.0.1:${port}/api/v1/escrow/genesis-receipt`,
    );
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).create_response.escrow_id, genesisId);
    await sleep(Number(values.linger));
    if (values.verbose) console.log(output);
    const listeningLine = output
      .split("\n")
      .find((line) => line.includes('"Server listening"'));
    const listeningMs = listeningLine
      ? JSON.parse(listeningLine).time - spawnedAtEpoch
      : undefined;
    return {
      portMs,
      healthMs,
      discoveryMs,
      escrowMs,
      listeningMs,
      failures: stats.failures,
    };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    await rm(workdir, { recursive: true, force: true });
  }
}

const home = await mkdtemp(path.join(tmpdir(), "api-startup-db-"));
const cluster = path.join(home, "data");
const databasePort = await reservePort();
let databaseStarted = false;
try {
  const schema = runTool(
    "pnpm",
    [
      "--filter",
      "@workspace/db",
      "exec",
      "drizzle-kit",
      "export",
      "--dialect=postgresql",
      "--schema=./src/schema/index.ts",
    ],
    home,
  );
  const sqlStart = schema.search(
    /^CREATE (?:TABLE|TYPE|SCHEMA|SEQUENCE|EXTENSION)/m,
  );
  assert.ok(sqlStart >= 0, "Database schema export did not contain SQL");
  await writeFile(path.join(home, "schema.sql"), schema.slice(sqlStart));
  runTool(
    "initdb",
    [
      "-D",
      cluster,
      "-U",
      "fixture",
      "--auth=trust",
      "--locale=C",
      "-E",
      "UTF8",
      "--no-instructions",
      "--no-sync",
    ],
    home,
  );
  runTool(
    "pg_ctl",
    [
      "-D",
      cluster,
      "-l",
      path.join(home, "postgres.log"),
      "-w",
      "-o",
      `-c listen_addresses=127.0.0.1 -p ${databasePort} -k ${home}`,
      "start",
    ],
    home,
  );
  databaseStarted = true;
  const psql = [
    "-h",
    "127.0.0.1",
    "-p",
    String(databasePort),
    "-U",
    "fixture",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
  ];
  runTool(
    "psql",
    [...psql, "-d", "postgres", "-c", "CREATE DATABASE fixture"],
    home,
  );
  runTool(
    "psql",
    [...psql, "-d", "fixture", "-f", path.join(home, "schema.sql")],
    home,
  );
  const context = {
    databasePort,
    databaseUrl: `postgresql://fixture@127.0.0.1:${databasePort}/fixture`,
    home,
  };

  // The first boot seeds the durable genesis baseline; a republish recovers an
  // existing ledger, so only the following runs are measured.
  await measure({ ...context, port: await reservePort() });
  const results = [];
  for (let run = 0; run < runs; run++) {
    results.push(await measure({ ...context, port: await reservePort() }));
  }
  const columns = [
    ["port", "portMs"],
    ["health", "healthMs"],
    ["mcp.json", "discoveryMs"],
    ["escrow", "escrowMs"],
    ["app", "listeningMs"],
  ];
  const format = (value) =>
    (value === undefined ? "n/a" : Math.round(value).toString()).padStart(9);
  console.log(
    `bundle: ${path.relative(root, bundle)}\n${"run".padEnd(7)}${columns.map(([label]) => label.padStart(9)).join("")}  failures`,
  );
  results.forEach((result, index) => {
    console.log(
      `${String(index + 1).padEnd(7)}${columns.map(([, key]) => format(result[key])).join("")}  ${result.failures.length}`,
    );
  });
  const median = (key) => {
    const sorted = results
      .map((result) => result[key])
      .filter((value) => value !== undefined)
      .sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
  };
  console.log(
    `${"median".padEnd(7)}${columns.map(([, key]) => format(median(key))).join("")}`,
  );
  const failures = results.flatMap((result) => result.failures);
  if (failures.length)
    console.log(
      `Responses that failed after the port opened:\n  ${failures.join("\n  ")}`,
    );
} finally {
  if (databaseStarted) {
    spawnSync("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"], {
      env: { PATH: process.env.PATH, HOME: home, LC_ALL: "C" },
      stdio: "ignore",
    });
  }
  await rm(home, { recursive: true, force: true });
}
