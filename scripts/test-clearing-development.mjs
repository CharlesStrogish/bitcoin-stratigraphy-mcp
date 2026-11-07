// Run ONLY clearing's isolated integration suite, never the core data tools.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
  throw new Error("Development clearing tests must not run on a deployment");
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "tsx",
    "--test",
    "artifacts/api-server/src/routes/clearing-execution.test.ts",
  ],
  {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      CLEARING_DEVELOPMENT_SETTLEMENT: "1",
      NIP98_PUBLIC_ORIGIN: "",
    },
  },
);
process.exit(result.status ?? 1);
