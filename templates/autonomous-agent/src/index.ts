import { logStartupError, runWorker } from "./runner.js";

runWorker(Number(process.env.POLL_INTERVAL_MS ?? 3_600_000)).catch((error: unknown) => {
  logStartupError(error);
  process.exitCode = 1;
});