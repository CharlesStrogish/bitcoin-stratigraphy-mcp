import { runWorker } from "./runner.js";

runWorker(Number(process.env.POLL_INTERVAL_MS ?? 3_600_000)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Agent startup failed");
  process.exitCode = 1;
});