import type { IAgentRuntime, Provider } from "@elizaos/core";

type CachedTelemetry = {
  fetchedAt: string;
  day?: number;
  date?: string;
  blockHeight?: number;
  metrics?: Record<string, string | number>;
};

function cacheKey(runtime: IAgentRuntime): string {
  return `bitcoin-stratigraphy:telemetry:${runtime.agentId}`;
}

/** Save only the latest fetched snapshot, not credentials or entire paid datasets. */
export async function rememberTelemetry(
  runtime: IAgentRuntime,
  result: Record<string, unknown>,
  selectedBlockHeight?: number,
): Promise<boolean> {
  const records = result.records;
  if (!Array.isArray(records) || records.length === 0) return true;
  const latest = records
    .filter(
      (row): row is Record<string, unknown> =>
        !!row && typeof row === "object" && !Array.isArray(row),
    )
    .sort((a, b) => (Number(b.day) || 0) - (Number(a.day) || 0))[0];
  if (!latest || typeof latest !== "object" || Array.isArray(latest))
    return true;
  const row = latest as Record<string, unknown>;
  const alpha = row.quantitative_alpha;
  const metrics =
    alpha && typeof alpha === "object" && !Array.isArray(alpha)
      ? Object.fromEntries(
          Object.entries(alpha).filter(
            (entry): entry is [string, string | number] =>
              (typeof entry[1] === "number" && Number.isFinite(entry[1])) ||
              (typeof entry[1] === "string" && entry[1].length <= 100),
          ),
        )
      : undefined;
  const state: CachedTelemetry = {
    fetchedAt: new Date().toISOString(),
    ...(typeof row.day === "number" ? { day: row.day } : {}),
    ...(typeof row.date === "string" ? { date: row.date } : {}),
    ...(typeof row.blockHeight === "number"
      ? { blockHeight: row.blockHeight }
      : selectedBlockHeight !== undefined
        ? { blockHeight: selectedBlockHeight }
        : {}),
    ...(metrics ? { metrics } : {}),
  };
  return runtime.setCache(cacheKey(runtime), state);
}

export const bitcoinStratigraphyProvider: Provider = {
  name: "BITCOIN_STRATIGRAPHY_STATE",
  description:
    "The last fetched Bitcoin block and telemetry snapshot, without a new payment",
  get: async (runtime) => {
    const cached = await runtime.getCache<CachedTelemetry>(cacheKey(runtime));
    if (!cached || !Number.isFinite(Date.parse(cached.fetchedAt))) {
      return {
        text: "No Bitcoin Stratigraphy telemetry has been fetched for this agent yet.",
      };
    }
    const details = [
      cached.date && `date ${cached.date}`,
      cached.day !== undefined && `day ${cached.day}`,
      cached.blockHeight !== undefined &&
        `queried block height ${cached.blockHeight}`,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      text: `Last fetched Bitcoin Stratigraphy telemetry${details ? ` (${details})` : ""}, as of ${cached.fetchedAt}. This is cached, not necessarily the current chain tip.${cached.metrics ? ` Metrics: ${JSON.stringify(cached.metrics)}.` : ""}`,
      values: {
        bitcoinStratigraphyFetchedAt: cached.fetchedAt,
        bitcoinStratigraphyBlockHeight: cached.blockHeight ?? null,
        bitcoinStratigraphyMetrics: cached.metrics ?? {},
      },
      data: { telemetry: cached },
    };
  },
};
