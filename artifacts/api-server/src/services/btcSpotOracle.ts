/** Spot quotes are admission inputs, never a substitute for settlement proof. */
export class BtcSpotUnavailable extends Error {
  readonly status = 503;
  readonly code = "btc_spot_oracle_unavailable";
  constructor() { super("btc_spot_oracle_unavailable"); }
}
export type SpotOracle = { quote(): Promise<{ btcUsd: number; observedAt: number }> };
export function createBtcSpotOracle(options: {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number;
} = {}): SpotOracle {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { btcUsd: number; observedAt: number } | undefined;
  let pending: Promise<{ btcUsd: number; observedAt: number }> | undefined;
  const feed = async (url: string, read: (body: any) => unknown) => {
    const response = await request(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 4000), redirect: "error" });
    if (!response.ok) throw new BtcSpotUnavailable();
    const raw = read(await response.json());
    if ((typeof raw !== "string" && typeof raw !== "number") || String(raw).trim() === "") throw new BtcSpotUnavailable();
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new BtcSpotUnavailable();
    return value;
  };
  return {
    async quote() {
      if (cached && now() >= cached.observedAt && now() - cached.observedAt < 60_000) return { ...cached };
      if (!pending) pending = (async () => {
        const [coinbase, kraken] = await Promise.allSettled([
          feed("https://api.coinbase.com/v2/prices/BTC-USD/spot", body => body?.data?.amount),
          feed("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", body => body?.result?.XXBTZUSD?.c?.[0]),
        ]);
        const a = coinbase.status === "fulfilled" ? coinbase.value : undefined;
        const b = kraken.status === "fulfilled" ? kraken.value : undefined;
        if ((!a && !b) || (a && b && Math.abs(a - b) / Math.min(a, b) > 0.15)) throw new BtcSpotUnavailable();
        cached = { btcUsd: a ?? b!, observedAt: now() };
        return { ...cached };
      })().finally(() => { pending = undefined; });
      return { ...await pending };
    },
  };
}
export const btcSpotOracle = createBtcSpotOracle();
export function usdToSats(usd: number, btcUsd: number): number {
  const sats = Math.ceil((usd / btcUsd) * 1e8);
  if (!Number.isFinite(btcUsd) || btcUsd <= 0 || !Number.isSafeInteger(sats) || sats <= 0 || sats > Number.MAX_SAFE_INTEGER / 1000)
    throw new BtcSpotUnavailable();
  return sats;
}
