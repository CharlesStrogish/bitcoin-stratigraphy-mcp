import {
  SimplePool,
  type Event,
  type Filter,
} from "nostr-tools";
import type { RelayConnectionStatus } from "./announcer";

export type RelayCircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";

export type RelayHealth = RelayConnectionStatus & {
  circuitState: RelayCircuitState;
  consecutiveFailures: number;
  nextRetryAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export type RelayPoolHealth = {
  healthyRelays: number;
  totalRelays: number;
  queuedEvents: number;
  relays: RelayHealth[];
};

export type AutoHealingRelayPool = {
  subscribe(filter: Filter, onEvent: (event: Event) => void): () => void;
  publish(event: Event): Promise<void>;
  relayStatuses(): RelayConnectionStatus[];
  health(): RelayPoolHealth;
  close(): void;
};

type RelayState = {
  circuitState: RelayCircuitState;
  failures: number;
  nextRetryAt: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  message?: string;
};

let latestHealth: RelayPoolHealth = {
  healthyRelays: 0,
  totalRelays: 0,
  queuedEvents: 0,
  relays: [],
};

export function getRelayPoolHealth(): RelayPoolHealth {
  return structuredClone(latestHealth);
}

export function createAutoHealingRelayPool(options: {
  relays: string[];
  publishRelay: (relay: string, event: Event) => Promise<void>;
  subscribeRelays: (
    relays: string[],
    filter: Filter,
    onEvent: (event: Event) => void,
  ) => () => void;
  reconnectRelay?: (relay: string) => Promise<void>;
  closeTransport?: () => void;
  now?: () => number;
  failureThreshold?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  monitorIntervalMs?: number;
  maxQueuedEventsPerRelay?: number;
  scheduler?: {
    setInterval(callback: () => void, milliseconds: number): unknown;
    clearInterval(handle: unknown): void;
  };
}): AutoHealingRelayPool {
  const relays = [...new Set(options.relays)];
  const now = options.now ?? Date.now;
  const failureThreshold = options.failureThreshold ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const maxQueuedEventsPerRelay = options.maxQueuedEventsPerRelay ?? 100;
  const scheduler = options.scheduler ?? {
    setInterval: (callback: () => void, milliseconds: number) =>
      setInterval(callback, milliseconds),
    clearInterval: (handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const states = new Map<string, RelayState>(
    relays.map((relay) => [
      relay,
      {
        circuitState: "CLOSED",
        failures: 0,
        nextRetryAt: 0,
      },
    ]),
  );
  let closed = false;
  const operationLocks = new Map<string, Promise<void>>();
  const retryQueues = new Map<string, Map<string, Event>>(
    relays.map((relay) => [relay, new Map()]),
  );

  const runExclusive = <Value>(
    relay: string,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = operationLocks.get(relay) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const completion = current.then(
      () => undefined,
      () => undefined,
    );
    operationLocks.set(relay, completion);
    void completion.finally(() => {
      if (operationLocks.get(relay) === completion) {
        operationLocks.delete(relay);
      }
    });
    return current;
  };

  const snapshot = (): RelayPoolHealth => {
    let healthyRelays = 0;
    const relayHealth = relays.map((relay): RelayHealth => {
      const state = states.get(relay)!;
      const status =
        state.circuitState === "CLOSED" && state.lastSuccessAt !== undefined
          ? "connected"
          : state.lastFailureAt !== undefined
            ? "failed"
            : "pending";
      if (status === "connected") healthyRelays += 1;
      return {
        relay,
        status,
        ...(state.message ? { message: state.message } : {}),
        circuitState: state.circuitState,
        consecutiveFailures: state.failures,
        nextRetryAt: state.nextRetryAt
          ? new Date(state.nextRetryAt).toISOString()
          : null,
        lastSuccessAt: state.lastSuccessAt
          ? new Date(state.lastSuccessAt).toISOString()
          : null,
        lastFailureAt: state.lastFailureAt
          ? new Date(state.lastFailureAt).toISOString()
          : null,
      };
    });
    const health: RelayPoolHealth = {
      healthyRelays,
      totalRelays: relays.length,
      queuedEvents: [...retryQueues.values()].reduce(
        (total, queue) => total + queue.size,
        0,
      ),
      relays: relayHealth,
    };
    latestHealth = structuredClone(health);
    return health;
  };

  const markSuccess = (relay: string) => {
    states.set(relay, {
      circuitState: "CLOSED",
      failures: 0,
      nextRetryAt: 0,
      lastSuccessAt: now(),
    });
    snapshot();
  };

  const markFailure = (relay: string, error: unknown) => {
    const current = states.get(relay)!;
    const failures = current.failures + 1;
    const shouldOpen =
      current.circuitState === "HALF-OPEN" || failures >= failureThreshold;
    const delay = Math.min(
      maxBackoffMs,
      baseBackoffMs * 2 ** Math.max(0, failures - failureThreshold),
    );
    states.set(relay, {
      ...current,
      circuitState: shouldOpen ? "OPEN" : "CLOSED",
      failures,
      nextRetryAt: shouldOpen ? now() + delay : 0,
      lastFailureAt: now(),
      message: error instanceof Error ? error.message : String(error),
    });
    snapshot();
  };

  const enqueue = (relay: string, event: Event) => {
    const queue = retryQueues.get(relay)!;
    queue.delete(event.id);
    queue.set(event.id, event);
    while (queue.size > maxQueuedEventsPerRelay) {
      const oldest = queue.keys().next();
      if (oldest.done) break;
      queue.delete(oldest.value);
    }
    snapshot();
  };

  const flushQueue = async (relay: string) => {
    const queue = retryQueues.get(relay)!;
    for (const [eventId, event] of queue) {
      if (closed) return;
      try {
        await options.publishRelay(relay, event);
        queue.delete(eventId);
        markSuccess(relay);
      } catch (error) {
        markFailure(relay, error);
        return;
      }
    }
    snapshot();
  };

  const attempt = (relay: string, event: Event) =>
    runExclusive(relay, async () => {
      if (closed) return false;
      const state = states.get(relay)!;
      if (state.circuitState === "OPEN") {
        if (now() < state.nextRetryAt) {
          enqueue(relay, event);
          return false;
        }
        state.circuitState = "HALF-OPEN";
        snapshot();
        try {
          await options.reconnectRelay?.(relay);
        } catch (error) {
          markFailure(relay, error);
          enqueue(relay, event);
          return false;
        }
      }
      try {
        await options.publishRelay(relay, event);
        retryQueues.get(relay)!.delete(event.id);
        markSuccess(relay);
        return true;
      } catch (error) {
        markFailure(relay, error);
        enqueue(relay, event);
        return false;
      }
    });

  const monitor = scheduler.setInterval(() => {
    if (closed || !options.reconnectRelay) return;
    for (const relay of relays) {
      const state = states.get(relay)!;
      if (operationLocks.has(relay)) continue;
      if (state.circuitState === "OPEN" && now() < state.nextRetryAt) continue;
      void runExclusive(relay, async () => {
        const current = states.get(relay)!;
        if (current.circuitState === "OPEN") {
          current.circuitState = "HALF-OPEN";
          snapshot();
        }
        try {
          await options.reconnectRelay!(relay);
          markSuccess(relay);
          await flushQueue(relay);
        } catch (error) {
          markFailure(relay, error);
        }
      });
    }
  }, options.monitorIntervalMs ?? 5_000);
  if (
    monitor &&
    typeof monitor === "object" &&
    "unref" in monitor &&
    typeof monitor.unref === "function"
  ) {
    monitor.unref();
  }
  snapshot();

  return {
    subscribe(filter, onEvent) {
      return options.subscribeRelays(relays, filter, onEvent);
    },
    async publish(event) {
      if (closed) throw new Error("Relay pool is closed");
      const outcomes = await Promise.all(relays.map((relay) => attempt(relay, event)));
      if (!outcomes.some(Boolean)) {
        throw new Error("No configured Nostr relay accepted the event");
      }
    },
    relayStatuses() {
      return snapshot().relays.map(({ relay, status, message }) => ({
        relay,
        status,
        ...(message ? { message } : {}),
      }));
    },
    health: snapshot,
    close() {
      if (closed) return;
      closed = true;
      scheduler.clearInterval(monitor);
      for (const queue of retryQueues.values()) queue.clear();
      snapshot();
      options.closeTransport?.();
    },
  };
}

export function createNostrRelayPool(
  relays: string[],
  pool = new SimplePool({ enableReconnect: true }),
): AutoHealingRelayPool {
  const abortController = new AbortController();
  return createAutoHealingRelayPool({
    relays,
    async publishRelay(relay, event) {
      const [result] = pool.publish([relay], event, {
        maxWait: 5_000,
        abort: abortController.signal,
      });
      await result;
    },
    subscribeRelays(subscribedRelays, filter, onEvent) {
      const subscription = pool.subscribeMany(subscribedRelays, filter, {
        onevent: onEvent,
        abort: abortController.signal,
      });
      return () => subscription.close("Relay pool subscription closed");
    },
    async reconnectRelay(relay) {
      await pool.ensureRelay(relay, { connectionTimeout: 5_000 });
    },
    closeTransport() {
      abortController.abort();
      pool.destroy();
    },
  });
}