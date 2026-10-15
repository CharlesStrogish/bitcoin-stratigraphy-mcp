// Application startup, bundled as dist/server.mjs. The bootstrap entry
// (index.ts) imports this module only after the HTTP port is bound, so the
// cost of evaluating the application never leaves the port closed.
import type { StartupServer } from "./lib/startup-server";
import app, { escrowRecovery, provenanceAnchoring } from "./app";
import { logger } from "./lib/logger";
import { startNostrHeartbeat } from "./lib/nostr-heartbeat";
import { startNip90Dvm } from "./services/dvm";
import { albySettlementMode } from "./services/settlement/alby";
import {
  prewarmZkVerifier,
  shutdownZkVerifier,
} from "./services/zkProofService";

const ZK_PREWARM_TIMEOUT_MS = 60_000;

const milliseconds = (value: number) => Number(value.toFixed(3));

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function startApplication({
  startup,
  port,
  portBoundMs,
}: {
  startup: StartupServer;
  port: number;
  /** Milliseconds from process start until the port accepted connections. */
  portBoundMs: number;
}): void {
  const applicationLoadedMs = performance.now();
  let stopping = false;
  let stopDvm: (() => Promise<void>) | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  let stopAnchoring: (() => void) | undefined;

  // Escrow routes wait on this gate and answer 503 until the durable ledger
  // has been recovered; every other route is served as soon as it attaches.
  const firstRecovery = escrowRecovery.start();
  startup.attach(app);
  logger.info(
    {
      port,
      portBoundMs: milliseconds(portBoundMs),
      applicationLoadedMs: milliseconds(applicationLoadedMs),
    },
    "Server listening",
  );
  if (albySettlementMode() === "standby") {
    logger.warn(
      { settlementProvider: "alby", mode: "standby" },
      "Alby settlement fallback is in standby mode; set ALBY_NWC_URI to enable live failover",
    );
  }

  const heartbeatStartup = startNostrHeartbeat()
    .then(async (stop) => {
      if (stopping) {
        await stop();
        return;
      }
      stopHeartbeat = stop;
    })
    .catch((error) => {
      logger.warn({ err: error }, "Nostr heartbeat startup failed");
    });
  const dvmStartup = startNip90Dvm()
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

  // Heavy warm-up and external calendar calls run only after requests are
  // being served, and after the first recovery attempt so they never compete
  // with it. Failures are logged; the work they warm up still runs on demand.
  void firstRecovery
    .then(async () => {
      if (stopping) return;
      const warmupStartedAt = performance.now();
      try {
        await withTimeout(
          prewarmZkVerifier(),
          ZK_PREWARM_TIMEOUT_MS,
          `zk verifier warm-up exceeded ${ZK_PREWARM_TIMEOUT_MS} ms`,
        );
        logger.info(
          { durationMs: milliseconds(performance.now() - warmupStartedAt) },
          "zk verifier pre-warmed",
        );
      } catch (error) {
        logger.warn(
          { err: error },
          "zk verifier warm-up failed; proofs are still verified on demand",
        );
      }
      if (!stopping) stopAnchoring = provenanceAnchoring.start();
    })
    .catch((error) => {
      logger.error({ err: error }, "Background startup tasks failed");
    });

  async function stopServer(signal: string) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Stopping server");
    escrowRecovery.stop();
    stopAnchoring?.();
    await Promise.all([dvmStartup, heartbeatStartup]);
    await stopHeartbeat?.();
    await stopDvm?.();
    await new Promise<void>((resolve) => startup.server.close(() => resolve()));
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
}
