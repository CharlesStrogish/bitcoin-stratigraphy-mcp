import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { VerifyAuditResponse } from "@workspace/api-zod";

export class AuditWorkerError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type AuditRequest = { mode: "journal" | "trace"; content: string };

export function verifyAuditEvidence(input: AuditRequest, signal: AbortSignal) {
  return new Promise<ReturnType<typeof VerifyAuditResponse.parse>>((resolve, reject) => {
    if (signal.aborted) return reject(new AuditWorkerError(503, "Verification cancelled"));
    // Keep application, wallet, model and payment credentials out of this process.
    const allowed = new Set(["PATH", "HOME", "LANG", "LC_ALL", "SSL_CERT_FILE",
      "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "REPLIT_PYTHONPATH",
      "PYTHON_LD_LIBRARY_PATH", "NIX_PROFILES"]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
    // Replit's shell python3 can be an older ABI than the managed project runtime.
    const managedPython = fileURLToPath(new URL("../../../.pythonlibs/bin/python3", import.meta.url));
    const child = spawn(existsSync(managedPython) ? managedPython : "python3",
      [fileURLToPath(new URL("./audit-worker/cookbooks/audit_web_worker.py", import.meta.url))], {
      env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: ReturnType<typeof VerifyAuditResponse.parse>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new AuditWorkerError(503, "Verification cancelled"));
    const timer = setTimeout(() => finish(new AuditWorkerError(503, "Verification timed out; try a smaller journal")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new AuditWorkerError(503, "Verification worker unavailable")));
    child.stdin.on("error", () => finish(new AuditWorkerError(503, "Verification worker unavailable")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) finish(new AuditWorkerError(503, "Verification output exceeds limits"));
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code === 2) return finish(new AuditWorkerError(400, "Malformed submission or audit limits exceeded"));
      if (code !== 0) return finish(new AuditWorkerError(503, "Verification worker unavailable"));
      try { finish(undefined, VerifyAuditResponse.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch { finish(new AuditWorkerError(503, "Invalid verification worker response")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
