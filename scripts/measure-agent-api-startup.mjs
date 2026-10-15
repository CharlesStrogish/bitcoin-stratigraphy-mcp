// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
// Measures cold-start readiness of the Python Enterprise Agent API (/agent-api,
// port 8000 in production).
//
//   node scripts/measure-agent-api-startup.mjs [--runs 5] [--root <dir with main.py>]
//     [--verbose]
//
// Each run starts the production command (`uv run --no-sync python main.py`)
// from --root with the workspace's Python environment, through a small launcher
// that disables DNS and every non-loopback connection. The process receives no
// App Storage bucket, Bitcoin Core RPC settings or other credentials, so it
// never reads or writes real archives or contacts public price, mempool or
// calendar services. Reported times are milliseconds from process spawn:
//   port     TCP port accepts connections (the proxy stops returning 500s)
//   health   GET /agent-api/health returns 200 from the application
//   app      the application's readiness log line ("Enterprise Agent API ready",
//            or uvicorn's "Application startup complete." for older builds)
// "failures" counts non-200 responses and errors received after the port
// opened. Timings use a warm file cache; on a cold production machine every
// module is read from disk, so production startup is much slower.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    root: { type: "string", default: "." },
    verbose: { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
assert.ok(
  Number.isInteger(runs) && runs > 0,
  "--runs must be a positive integer",
);
const root = path.resolve(workspace, values.root);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs main.py exactly as `python main.py` would (same argv, sys.path[0] and
// __main__), after replacing name resolution and connects with loopback-only
// versions.
const launcher = `
import ipaddress, os, runpy, socket, sys

_getaddrinfo = socket.getaddrinfo
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex

def _loopback(host):
    if isinstance(host, bytes):
        host = host.decode()
    if host in (None, "", "localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified

def getaddrinfo(host, *args, **kwargs):
    if not _loopback(host):
        raise socket.gaierror(socket.EAI_NONAME, "Startup measurement: outbound DNS disabled")
    return _getaddrinfo(host, *args, **kwargs)

def _allowed(sock, address):
    return sock.family == socket.AF_UNIX or _loopback(address[0])

def connect(self, address):
    if not _allowed(self, address):
        raise ConnectionRefusedError("Startup measurement: outbound connections disabled")
    return _connect(self, address)

def connect_ex(self, address):
    if not _allowed(self, address):
        return 111
    return _connect_ex(self, address)

socket.getaddrinfo = getaddrinfo
socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
script = os.path.abspath(sys.argv[1])
sys.argv = sys.argv[1:]
sys.path[0] = os.path.dirname(script)
runpy.run_path(script, run_name="__main__")
`;

// Only what the workspace interpreter and uv need; no secrets or service
// credentials reach the measured process.
function childEnvironment(port) {
  const keep = (name) =>
    [
      "PATH",
      "HOME",
      "LANG",
      "LOCALE_ARCHIVE",
      "TZDIR",
      "TERM",
      "GLIBC_TUNABLES",
      "LD_AUDIT",
      "UV_PROJECT_ENVIRONMENT",
      "PYTHONPATH",
      "PYTHONUSERBASE",
      "PYTHON_LD_LIBRARY_PATH",
      "REPLIT_LD_AUDIT",
      "REPLIT_LD_LIBRARY_PATH",
      "REPLIT_RTLD_LOADER",
      "REPLIT_PYTHONPATH",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ].includes(name) || name.startsWith("LC_");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => keep(name)),
  );
  return { ...env, PORT: String(port) };
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
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

async function measure(launcherPath) {
  const port = await reservePort();
  const startedAt = performance.now();
  const child = spawn(
    "uv",
    [
      "run",
      "--no-sync",
      "--project",
      workspace,
      "python",
      launcherPath,
      "main.py",
    ],
    {
      cwd: root,
      env: childEnvironment(port),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so uv and its Python child stop together.
      detached: true,
    },
  );
  const lines = [];
  const markers = {};
  let pending = "";
  const record = (bytes) => {
    const arrivedAt = performance.now() - startedAt;
    pending += bytes;
    const complete = pending.split("\n");
    pending = complete.pop();
    for (const line of complete) {
      lines.push(line);
      if (line.includes("Enterprise Agent API ready"))
        markers.ready ??= arrivedAt;
      if (line.includes("Application startup complete."))
        markers.startupComplete ??= arrivedAt;
    }
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stats = { failures: [], exited: false };
  void exited.then(() => {
    stats.exited = true;
  });
  const deadline = startedAt + 90_000;
  try {
    let portMs;
    while (performance.now() < deadline && !stats.exited) {
      if (await portOpen(port)) {
        portMs = performance.now() - startedAt;
        break;
      }
      await sleep(10);
    }
    let healthMs;
    while (
      portMs !== undefined &&
      performance.now() < deadline &&
      !stats.exited
    ) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/agent-api/health`,
          {
            signal: AbortSignal.timeout(
              Math.max(1, Math.ceil(deadline - performance.now())),
            ),
          },
        );
        const body = await response.text();
        if (response.status === 200) {
          const health = JSON.parse(body);
          assert.equal(health.status, "ok");
          assert.equal(health.service, "enterprise-agent-api");
          healthMs = performance.now() - startedAt;
          break;
        }
        stats.failures.push(`health ${response.status} ${body.slice(0, 120)}`);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        stats.failures.push(`health ${error.cause?.code ?? error.name}`);
      }
      await sleep(25);
    }
    // Let the readiness log line arrive if it trails the first response.
    const settleUntil = performance.now() + 2_000;
    while (
      markers.ready === undefined &&
      markers.startupComplete === undefined &&
      performance.now() < settleUntil
    ) {
      await sleep(20);
    }
    if (values.verbose) console.log(lines.join("\n"));
    if (portMs === undefined || healthMs === undefined) {
      throw new Error(
        `Enterprise Agent API never became ready:\n${stats.failures.slice(-5).join("\n")}\n${lines.slice(-40).join("\n")}`,
      );
    }
    return {
      portMs,
      healthMs,
      appMs: markers.ready ?? markers.startupComplete,
      failures: stats.failures,
    };
  } finally {
    if (!stats.exited) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 10_000);
      await exited;
      clearTimeout(timer);
    }
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), "agent-api-startup-"));
try {
  const launcherPath = path.join(scratch, "launch.py");
  await writeFile(launcherPath, launcher);
  // One unmeasured run first, so every measured run sees the same file cache.
  await measure(launcherPath);
  const results = [];
  for (let run = 0; run < runs; run++)
    results.push(await measure(launcherPath));
  const columns = [
    ["port", "portMs"],
    ["health", "healthMs"],
    ["app", "appMs"],
  ];
  const format = (value) =>
    (value === undefined ? "n/a" : Math.round(value).toString()).padStart(9);
  console.log(
    `root: ${path.relative(workspace, root) || "."}\n${"run".padEnd(7)}${columns.map(([label]) => label.padStart(9)).join("")}  failures`,
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
  await rm(scratch, { recursive: true, force: true });
}
