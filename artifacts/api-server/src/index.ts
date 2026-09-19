import app from "./app";
import { logger } from "./lib/logger";
import { startNostrHeartbeat } from "./lib/nostr-heartbeat";
import { albySettlementMode } from "./services/settlement/alby";
import { prewarmZkVerifier } from "./services/zkProofService";

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

app.listen(port, (err) => {
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
});
