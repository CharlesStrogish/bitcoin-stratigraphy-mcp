import { createAlbySettlementProvider } from "./alby";
import { createCoinosSettlementProvider } from "./coinos";
import type { NwcClientFactory } from "./nwc-provider";
import {
  SettlementProviderError,
  type SettlementInvoice,
  type SettlementInvoiceInput,
  type SettlementProvider,
  type SettlementVerification,
  type SettlementVerificationInput,
} from "./types";

export type SettlementCircuitState = "closed" | "open" | "half-open";

class SettlementRequestAbortedError extends Error {
  constructor() {
    super("Settlement request aborted");
    this.name = "AbortError";
  }
}

export interface SettlementRouter {
  isConfigured(): boolean;
  activeProvider(): string;
  circuitState(): SettlementCircuitState;
  createInvoice(input: SettlementInvoiceInput): Promise<SettlementInvoice>;
  verifyPayment(
    input: SettlementVerificationInput,
  ): Promise<SettlementVerification>;
}

export function createSettlementRouter(input: {
  primary: SettlementProvider;
  fallback: SettlementProvider;
  now?: () => number;
  failureThreshold?: number;
  cooldownMs?: number;
  operationTimeoutMs?: number;
}): SettlementRouter {
  const now = input.now ?? Date.now;
  const failureThreshold = input.failureThreshold ?? 3;
  const cooldownMs = input.cooldownMs ?? 5 * 60 * 1000;
  const operationTimeoutMs = input.operationTimeoutMs ?? 10_000;
  let consecutiveFailures = 0;
  let openedAt = 0;
  let state: SettlementCircuitState = input.primary.isConfigured()
    ? "closed"
    : "open";
  let probeInProgress = false;

  const openCircuit = () => {
    state = "open";
    openedAt = now();
    consecutiveFailures = Math.max(consecutiveFailures, failureThreshold);
  };
  const primarySucceeded = () => {
    state = "closed";
    consecutiveFailures = 0;
    openedAt = 0;
  };
  const primaryFailed = (error: unknown) => {
    consecutiveFailures += 1;
    if (
      (error instanceof SettlementProviderError && error.retryable) ||
      consecutiveFailures >= failureThreshold
    ) {
      openCircuit();
      return true;
    }
    return false;
  };
  const shouldProbe = () =>
    state === "open" &&
    input.primary.isConfigured() &&
    now() - openedAt >= cooldownMs;

  const withTimeout = async <T>(
    provider: SettlementProvider,
    operation: (
      provider: SettlementProvider,
      signal: AbortSignal,
    ) => Promise<T>,
    requestSignal?: AbortSignal,
  ) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectRequestAbort!: (error: SettlementRequestAbortedError) => void;
    const requestAborted = new Promise<never>((_resolve, reject) => {
      rejectRequestAbort = reject;
    });
    const abortRequest = () => {
      controller.abort(requestSignal?.reason);
      rejectRequestAbort(new SettlementRequestAbortedError());
    };
    requestSignal?.addEventListener("abort", abortRequest, { once: true });
    try {
      if (requestSignal?.aborted) throw new SettlementRequestAbortedError();
      return await Promise.race([
        operation(provider, controller.signal),
        requestAborted,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new SettlementProviderError(
                `${provider.name} settlement operation timed out`,
                true,
              ),
            );
          }, operationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      requestSignal?.removeEventListener("abort", abortRequest);
    }
  };

  const useFallback = async <T>(
    operation: (
      provider: SettlementProvider,
      signal: AbortSignal,
    ) => Promise<T>,
    requestSignal?: AbortSignal,
  ) => withTimeout(input.fallback, operation, requestSignal);

  const route = async <T>(
    operation: (
      provider: SettlementProvider,
      signal: AbortSignal,
    ) => Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<{ value: T; provider: SettlementProvider }> => {
    if (!input.primary.isConfigured()) {
      return {
        value: await useFallback(operation, requestSignal),
        provider: input.fallback,
      };
    }
    if (state === "open" && !shouldProbe()) {
      return {
        value: await useFallback(operation, requestSignal),
        provider: input.fallback,
      };
    }
    if ((state === "half-open" || shouldProbe()) && probeInProgress) {
      return {
        value: await useFallback(operation, requestSignal),
        provider: input.fallback,
      };
    }

    const probing = state !== "closed";
    if (probing) {
      state = "half-open";
      probeInProgress = true;
    }
    try {
      const result = await withTimeout(
        input.primary,
        operation,
        requestSignal,
      );
      primarySucceeded();
      return { value: result, provider: input.primary };
    } catch (error) {
      if (error instanceof SettlementRequestAbortedError) throw error;
      const fallbackAllowed = primaryFailed(error);
      if (!fallbackAllowed) throw error;
      return {
        value: await useFallback(operation, requestSignal),
        provider: input.fallback,
      };
    } finally {
      if (probing) probeInProgress = false;
    }
  };

  return {
    isConfigured: () =>
      input.primary.isConfigured() || input.fallback.isConfigured(),
    activeProvider: () =>
      (state === "closed" || shouldProbe()) && input.primary.isConfigured()
        ? input.primary.name
        : input.fallback.name,
    circuitState: () => state,
    async createInvoice(request) {
      return (
        await route(
          (provider, signal) =>
            provider.createInvoice({ ...request, signal }),
          request.signal,
        )
      ).value;
    },
    async verifyPayment(request) {
      const providers =
        activeProviderName() === input.primary.name
          ? [input.primary, input.fallback]
          : [input.fallback, input.primary];
      let unavailable = false;
      for (const provider of providers) {
        if (!provider.isConfigured()) continue;
        if (
          provider === input.primary &&
          state !== "closed" &&
          probeInProgress
        ) {
          unavailable = true;
          continue;
        }
        const ownsProbe =
          provider === input.primary &&
          state !== "closed" &&
          !probeInProgress;
        if (ownsProbe) {
          state = "half-open";
          probeInProgress = true;
        }
        try {
          const result = await withTimeout(
            provider,
            (selected, signal) =>
              selected.verifyPayment({ ...request, signal }),
            request.signal,
          );
          if (provider === input.primary) primarySucceeded();
          if (result !== "invalid") return result;
        } catch (error) {
          if (error instanceof SettlementRequestAbortedError) throw error;
          unavailable = true;
          if (provider === input.primary) primaryFailed(error);
        } finally {
          if (ownsProbe) probeInProgress = false;
        }
      }
      return unavailable ? "unavailable" : "invalid";
    },
  };

  function activeProviderName() {
    return (state === "closed" || shouldProbe()) &&
      input.primary.isConfigured()
      ? input.primary.name
      : input.fallback.name;
  }
}

export function createDefaultSettlementRouter(
  clientFactory?: NwcClientFactory,
) {
  return createSettlementRouter({
    primary: createCoinosSettlementProvider(clientFactory),
    fallback: createAlbySettlementProvider(clientFactory),
  });
}

export type {
  NwcClient,
  NwcClientFactory,
} from "./nwc-provider";
export { createNwcClient } from "./nwc-provider";
export type {
  SettlementInvoice,
  SettlementInvoiceInput,
  SettlementProvider,
  SettlementVerification,
  SettlementVerificationInput,
} from "./types";
export { SettlementProviderError } from "./types";