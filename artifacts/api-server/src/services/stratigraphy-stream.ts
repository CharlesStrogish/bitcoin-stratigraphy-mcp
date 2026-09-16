import { EventEmitter } from "node:events";

export type StratigraphyTelemetry = {
  observed_at: string;
  block: {
    height: number | null;
  };
  difficulty: {
    epoch_progress_percent: number;
    estimated_adjustment_percent: number | null;
  };
  market: {
    usd_per_btc: number | null;
    sats_per_usd: number | null;
  };
  thermodynamic: {
    signal: string;
    target_multiplier: number;
  };
};

export type IntervalScheduler = {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
};

export type StratigraphyTelemetryHub = {
  subscribe(listener: (telemetry: StratigraphyTelemetry) => void): () => void;
  activeSubscribers(): number;
};

const defaultScheduler: IntervalScheduler = {
  setInterval(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export function createStratigraphyTelemetryHub(input: {
  readTelemetry: () => Promise<StratigraphyTelemetry>;
  refreshMs?: number;
  scheduler?: IntervalScheduler;
  onError?: (error: unknown) => void;
}): StratigraphyTelemetryHub {
  const emitter = new EventEmitter();
  const scheduler = input.scheduler ?? defaultScheduler;
  const refreshMs = input.refreshMs ?? 30_000;
  let refreshTimer: unknown;
  let refreshInProgress: Promise<void> | undefined;

  const publish = () => {
    if (refreshInProgress) return refreshInProgress;
    refreshInProgress = input
      .readTelemetry()
      .then((telemetry) => {
        emitter.emit("telemetry", telemetry);
      })
      .catch((error) => input.onError?.(error))
      .finally(() => {
        refreshInProgress = undefined;
      });
    return refreshInProgress;
  };

  return {
    subscribe(listener) {
      emitter.on("telemetry", listener);
      if (!refreshTimer) {
        refreshTimer = scheduler.setInterval(() => {
          void publish();
        }, refreshMs);
      }
      void publish();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        emitter.off("telemetry", listener);
        if (emitter.listenerCount("telemetry") === 0 && refreshTimer) {
          scheduler.clearInterval(refreshTimer);
          refreshTimer = undefined;
        }
      };
    },
    activeSubscribers: () => emitter.listenerCount("telemetry"),
  };
}

async function readBoundedBody(response: Response, maxBytes = 64 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error("Telemetry response exceeded 64 KiB");
      }
      body += decoder.decode(result.value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function fetchJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Telemetry request failed: ${response.status}`);
  }
  return JSON.parse(await readBoundedBody(response)) as unknown;
}

async function fetchText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Telemetry request failed: ${response.status}`);
  }
  return readBoundedBody(response);
}

export async function readLiveBitcoinTelemetry(input: {
  epochProgressPercent: number;
  thermodynamicSignal: string;
  targetMultiplier: number;
  now?: () => number;
}): Promise<StratigraphyTelemetry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    const [heightResult, difficultyResult, pricesResult] =
      await Promise.allSettled([
        fetchText("https://mempool.space/api/blocks/tip/height", controller.signal),
        fetchJson(
          "https://mempool.space/api/v1/difficulty-adjustment",
          controller.signal,
        ),
        fetchJson("https://mempool.space/api/v1/prices", controller.signal),
      ]);
    const height =
      heightResult.status === "fulfilled"
        ? Number.parseInt(heightResult.value, 10)
        : Number.NaN;
    const difficulty =
      difficultyResult.status === "fulfilled" &&
      difficultyResult.value &&
      typeof difficultyResult.value === "object"
        ? difficultyResult.value as { difficultyChange?: unknown }
        : undefined;
    const prices =
      pricesResult.status === "fulfilled" &&
      pricesResult.value &&
      typeof pricesResult.value === "object"
        ? pricesResult.value as { USD?: unknown }
        : undefined;
    const usdPerBtc =
      typeof prices?.USD === "number" && Number.isFinite(prices.USD)
        ? prices.USD
        : null;
    return {
      observed_at: new Date((input.now ?? Date.now)()).toISOString(),
      block: {
        height: Number.isSafeInteger(height) && height > 0 ? height : null,
      },
      difficulty: {
        epoch_progress_percent: input.epochProgressPercent,
        estimated_adjustment_percent:
          typeof difficulty?.difficultyChange === "number" &&
          Number.isFinite(difficulty.difficultyChange)
            ? difficulty.difficultyChange
            : null,
      },
      market: {
        usd_per_btc: usdPerBtc,
        sats_per_usd: usdPerBtc ? 100_000_000 / usdPerBtc : null,
      },
      thermodynamic: {
        signal: input.thermodynamicSignal,
        target_multiplier: input.targetMultiplier,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const nodeIntervalScheduler = defaultScheduler;