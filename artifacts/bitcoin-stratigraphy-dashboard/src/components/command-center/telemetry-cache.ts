// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type { QueryFunctionContext, QueryKey } from "@tanstack/react-query";

const PREFIX = "bitcoin-stratigraphy:public-telemetry:v1:";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SNAPSHOT_BYTES = 32_768;
export const HOUR = 60 * 60_000;
const rateLimitCooldowns = new Map<string, { until: number; error: unknown }>();

export interface TelemetrySource<T> {
  key: string;
  queryKey: QueryKey;
  load: (signal: AbortSignal) => Promise<unknown>;
  parse: (value: unknown) => T;
  maxAge: number;
}

interface Snapshot<T> {
  data: T;
  updatedAt: number;
}

/** Same-origin browser storage; never seed a first visit with invented values. */
export function readTelemetrySnapshot<T>(
  source: Pick<TelemetrySource<T>, "key" | "parse" | "maxAge">,
  now = Date.now(),
): Snapshot<T> | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + source.key);
    if (!raw || raw.length > MAX_SNAPSHOT_BYTES) return undefined;
    const saved = JSON.parse(raw);
    if (
      !Number.isSafeInteger(saved.updatedAt) ||
      saved.updatedAt > now ||
      now - saved.updatedAt > source.maxAge
    ) {
      return undefined;
    }
    return { data: source.parse(saved.data), updatedAt: saved.updatedAt };
  } catch {
    // Storage may be blocked, full, corrupt, or absent during SSR.
    return undefined;
  }
}

export function writeTelemetrySnapshot<T>(
  source: Pick<TelemetrySource<T>, "key" | "parse">,
  value: unknown,
  now = Date.now(),
) {
  const data = source.parse(value);
  try {
    const raw = JSON.stringify({ data, updatedAt: now });
    if (raw.length <= MAX_SNAPSHOT_BYTES) {
      localStorage.setItem(PREFIX + source.key, raw);
    }
  } catch {
    // A successful network read remains usable even when persistence is denied.
  }
  return data;
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

export function retryTelemetry(failureCount: number, error: unknown) {
  const status = httpStatus(error);
  // One delayed retry for transient failures, never a rate-limit retry burst.
  // Invalid JSON/shapes and permanent HTTP failures are not transient.
  return (
    failureCount < 1 &&
    (status === 502 ||
      status === 503 ||
      status === 504 ||
      error instanceof TypeError ||
      (error instanceof Error && error.name === "TimeoutError"))
  );
}

export function telemetryRetryDelay(_attempt: number, error: unknown) {
  const headers =
    typeof error === "object" && error !== null && "headers" in error
      ? error.headers
      : undefined;
  const value = headers instanceof Headers ? headers.get("retry-after") : null;
  const seconds = value === null ? NaN : Number(value);
  const until = value === null ? NaN : Date.parse(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : until - Date.now();
  return Math.max(30_000, Number.isFinite(delay) ? delay : 0);
}

export function telemetryQueryOptions<T>(source: TelemetrySource<T>) {
  const cached = readTelemetrySnapshot(source);
  return {
    queryKey: source.queryKey,
    queryFn: async ({ signal }: QueryFunctionContext): Promise<T> => {
      const cooldown = rateLimitCooldowns.get(source.key);
      if (cooldown && cooldown.until > Date.now()) throw cooldown.error;
      rateLimitCooldowns.delete(source.key);
      const bounded = AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      try {
        const value = await source.load(bounded);
        bounded.throwIfAborted();
        return writeTelemetrySnapshot(source, value);
      } catch (error) {
        if (httpStatus(error) === 429) {
          rateLimitCooldowns.set(source.key, {
            until: Date.now() + telemetryRetryDelay(0, error),
            error,
          });
        }
        throw error;
      }
    },
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.updatedAt,
    // Restored values are useful immediately but must always be revalidated.
    staleTime: 0,
    gcTime: 24 * HOUR,
    retry: retryTelemetry,
    retryDelay: telemetryRetryDelay,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  };
}

interface FeedState {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
  isFetchedAfterMount: boolean;
  dataUpdatedAt: number;
}

export function telemetryFeedState(feeds: FeedState[]) {
  const missing = feeds.some((feed) => feed.data === undefined);
  const cached = feeds.some(
    (feed) =>
      feed.data !== undefined && (feed.isError || !feed.isFetchedAfterMount),
  );
  const refreshing = feeds.some((feed) => feed.isFetching);
  const timestamps = feeds
    .filter((feed) => feed.data !== undefined)
    .map((feed) => feed.dataUpdatedAt);
  return {
    label: missing
      ? "Connecting to telemetry"
      : cached
        ? "Showing last verified readings"
        : refreshing
          ? "Refreshing telemetry"
          : "Live",
    // Use the oldest available timestamp, not the newest (which can conceal
    // that one source is still a cached snapshot).
    updatedAt: timestamps.length ? Math.min(...timestamps) : 0,
    live: !missing && !cached,
  };
}
