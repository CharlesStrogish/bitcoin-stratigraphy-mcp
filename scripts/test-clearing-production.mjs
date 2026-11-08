// Synthetic production-profile clearing only. Never contacts a real wallet.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT)
  throw new Error("Do not run isolated clearing tests on a deployment");
const result = spawnSync("pnpm", [
  "exec", "tsx", "--test",
  "artifacts/api-server/src/routes/clearing-production.test.ts",
], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test", NIP98_PUBLIC_ORIGIN: "" },
});
process.exit(result.status ?? 1);
