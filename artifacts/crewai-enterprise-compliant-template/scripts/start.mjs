// Local supervisor: keep the dashboard available after a procurement halt.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const port = Number(process.env.VIEWER_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("VIEWER_PORT must be an integer between 1024 and 65535.");
}
if (!existsSync("dashboard/dist/public/index.html")) {
  throw new Error("Dashboard is not built. Run npm run setup first.");
}
const mode = process.env.SWARM_MODE || "demo";
if (!["demo", "live"].includes(mode)) throw new Error("SWARM_MODE must be demo or live.");
if (mode === "live" && !process.env.SWARM_WEBHOOK_URL?.trim()) {
  throw new Error("Live mode requires SWARM_WEBHOOK_URL.");
}
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 2500);
  force.unref();
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
function launch(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: false });
  children.add(child);
  child.on("error", () => {
    console.error("A starter process could not launch. Check installed runtimes.");
    stop(1);
  });
  child.on("exit", () => children.delete(child));
  return child;
}
const viewer = launch(process.execPath, ["dashboard/server.mjs"], {
  ...process.env,
  PORT: String(port),
  BASE_PATH: "/",
  HOST: "127.0.0.1",
  // Demo cannot accidentally verify a credential inherited from a parent shell.
  BITCOIN_STRATIGRAPHY_API_KEY: mode === "live"
    ? process.env.BITCOIN_STRATIGRAPHY_API_KEY || "" : "",
});
viewer.on("exit", () => { if (!stopping) stop(1); });
let ready = false;
for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/local-api/status`, {
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) { ready = true; break; }
  } catch { /* Waiting for the child server to bind. */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) {
  console.error("Dashboard failed to become ready.");
  stop(1);
} else if (!stopping) {
  console.log(`Flight Recorder Viewer: http://localhost:${port}`);
  const args = ["swarm.py", ...(process.argv.includes("--agent") ? ["--agent"] : [])];
  const swarm = launch(process.env.PYTHON || "python", args, { ...process.env, SWARM_MODE: mode });
  swarm.on("exit", (code, signal) => {
    if (stopping) return;
    console.log(`Swarm stopped (exit ${code ?? signal}); dashboard stays available. No automatic restart.`);
    if (code !== 0) process.exitCode = 1;
  });
}
