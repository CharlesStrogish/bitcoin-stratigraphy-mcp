import { runWorker } from "./runner.js";

// Reserved VM keeps this process alive. The loop waits 15 minutes after each
// cycle, exits on SIGINT/SIGTERM, and resumes from durable checkpoints.
runWorker(900_000).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seeder startup failed");
  process.exitCode = 1;
});