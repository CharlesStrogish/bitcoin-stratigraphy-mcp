// Isolated payout tests only. All LND REST responses are mocked.
import { spawnSync } from "node:child_process";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
  throw new Error("Clearing payout tests must not run on a deployment");
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "tsx",
    "--test",
    "artifacts/api-server/src/services/clearingPayout.test.ts",
  ],
  {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test", NIP98_PUBLIC_ORIGIN: "" },
  },
);
process.exit(result.status ?? 1);
