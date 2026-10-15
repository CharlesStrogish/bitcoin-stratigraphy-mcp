// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Startup recovery gate for the durable escrow ledger. The HTTP server accepts
// traffic before recovery finishes, so every /api/v1/escrow/* request waits for
// this gate. A ledger that is not yet recovered (or cannot be recovered) is
// answered with an explicit 503, never a zero or uninitialized counter.
import { executeEscrow, type EscrowExecutor } from "./escrowBridge";

export class EscrowLedgerRecoveringError extends Error {
  constructor(message = "Durable escrow ledger is recovering") {
    super(message);
    this.name = "EscrowLedgerRecoveringError";
  }
}

type RecoveryLogger = {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

export type EscrowRecoveryOptions = {
  execute?: EscrowExecutor;
  logger?: RecoveryLogger;
  /** Delay before each retry after a failed attempt; the last value repeats. */
  retryDelaysMs?: readonly number[];
  /** Longest time a request waits for an attempt already in progress. */
  maxWaitMs?: number;
};

export type EscrowRecovery = {
  readonly status: "idle" | "recovering" | "ready" | "retrying" | "stopped";
  /**
   * Starts recovery; resolves after the first attempt with whether it
   * succeeded. Failed attempts keep retrying in the background.
   */
  start(): Promise<boolean>;
  /** Resolves once recovered; rejects with EscrowLedgerRecoveringError otherwise. */
  whenReady(): Promise<void>;
  stop(): void;
};

export function createEscrowRecovery(
  options: EscrowRecoveryOptions = {},
): EscrowRecovery {
  const execute = options.execute ?? executeEscrow;
  const retryDelaysMs = options.retryDelaysMs ?? [
    2_000, 5_000, 10_000, 30_000, 60_000,
  ];
  const maxWaitMs = options.maxWaitMs ?? 25_000;
  let status: EscrowRecovery["status"] = "idle";
  let attempt: Promise<boolean> | undefined;
  let firstAttempt: Promise<boolean> | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let startedAt = 0;
  // Status changes while attempts are awaited; read it through a call so
  // checks after an await are not narrowed away by the compiler.
  const isStatus = (expected: EscrowRecovery["status"]) => status === expected;

  const runAttempt = (): Promise<boolean> => {
    status = "recovering";
    attempts += 1;
    const current = (async () => {
      try {
        const result = await execute("stats", {});
        if (result.status !== 200) {
          throw new Error(
            `Escrow ledger recovery returned HTTP ${result.status}`,
          );
        }
        if (isStatus("stopped")) return false;
        status = "ready";
        options.logger?.info(
          {
            attempts,
            durationMs: Number((performance.now() - startedAt).toFixed(3)),
          },
          "Escrow ledger recovered",
        );
        return true;
      } catch (error) {
        if (isStatus("stopped")) return false;
        status = "retrying";
        const delayMs =
          retryDelaysMs[Math.min(attempts - 1, retryDelaysMs.length - 1)];
        options.logger?.error(
          { err: error, attempts, retryInMs: delayMs },
          "Escrow ledger recovery failed; escrow routes return 503 until a retry succeeds",
        );
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (isStatus("retrying")) attempt = runAttempt();
        }, delayMs);
        retryTimer.unref();
        return false;
      }
    })();
    return current;
  };

  return {
    get status() {
      return status;
    },
    start() {
      if (!firstAttempt) {
        startedAt = performance.now();
        firstAttempt = attempt = runAttempt();
      }
      return firstAttempt;
    },
    async whenReady() {
      if (status === "ready") return;
      if (status !== "recovering" || !attempt)
        throw new EscrowLedgerRecoveringError();
      let timer: NodeJS.Timeout | undefined;
      const recovered = await Promise.race([
        attempt,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), maxWaitMs);
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer));
      if (!recovered || !isStatus("ready"))
        throw new EscrowLedgerRecoveringError();
    },
    stop() {
      status = "stopped";
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}
