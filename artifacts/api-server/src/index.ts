import app from "./app";
import { logger } from "./lib/logger";
import { startNostrHeartbeat } from "./lib/nostr-heartbeat";
import { startNip90Dvm } from "./services/dvm";
import { albySettlementMode } from "./services/settlement/alby";
import {
  prewarmZkVerifier,
  shutdownZkVerifier,
} from "./services/zkProofService";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const warmupStartedAt = performance.now();
await prewarmZkVerifier();
logger.info(
  { durationMs: Number((performance.now() - warmupStartedAt).toFixed(3)) },
  "zk verifier pre-warmed",
);

let stopDvm: (() => Promise<void>) | undefined;
let dvmStartup: Promise<void> | undefined;
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  if (albySettlementMode() === "standby") {
    logger.warn(
      { settlementProvider: "alby", mode: "standby" },
      "Alby settlement fallback is in standby mode; set ALBY_NWC_URI to enable live failover",
    );
  }
  void startNostrHeartbeat().catch((error) => {
    logger.warn({ err: error }, "Nostr heartbeat startup failed");
  });
  dvmStartup = startNip90Dvm()
    .then(async (stop) => {
      if (stopping) {
        await stop();
        return;
      }
      stopDvm = stop;
    })
    .catch((error) => {
      logger.error({ err: error }, "NIP-90 DVM startup failed");
    });
});

let stopping = false;
async function stopServer(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Stopping server");
  await dvmStartup;
  await stopDvm?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await shutdownZkVerifier();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stopServer(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, "Server shutdown failed");
        process.exit(1);
      });
  });
}
