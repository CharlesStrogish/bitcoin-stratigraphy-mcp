import { logStartupError, runWorker } from "./runner.js";

// Reserved VM keeps this process alive. The loop waits 15 minutes after each
// cycle, exits on SIGINT/SIGTERM, and resumes from durable checkpoints.
runWorker(900_000).catch((error: unknown) => {
  logStartupError(error);
  process.exitCode = 1;
});
