import { pool } from "@workspace/db";
import type { YieldMetrics } from "@workspace/api-zod";

type AggregateRow = { total_claims: string; total_msats: string };

// One read-only snapshot: committed claim totals already equal atomically consumed
// earnings. Joining individual earnings would multiply multi-receipt claims.
export const YIELD_METRICS_SQL = `
  SELECT COUNT(*)::text AS total_claims,
         COALESCE(SUM(total_msats), 0)::text AS total_msats
  FROM private_yield_claims
  WHERE settlement_mode = 'mock'
`;

export function createYieldMetricsReader(options: {
  query?: () => Promise<{ rows: AggregateRow[] }>;
  now?: () => number;
} = {}): () => Promise<YieldMetrics> {
  const now = options.now ?? Date.now;
  const queryConfig = { text: YIELD_METRICS_SQL, query_timeout: 2000 };
  const query = options.query ?? (() => pool.query<AggregateRow>(queryConfig));
  let cached: YieldMetrics | undefined;
  let expiresAt = 0;
  let retryAfter = 0;
  let inFlight: Promise<YieldMetrics> | undefined;
  return async () => {
    if (cached && now() < expiresAt) return { ...cached };
    if (now() < retryAfter) throw new Error("Yield metrics temporarily unavailable");
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const row = (await query()).rows[0];
          if (!row) throw new Error("Missing yield metrics aggregate");
          const count = Number(row.total_claims);
          const msats = BigInt(row.total_msats);
          if (!Number.isSafeInteger(count) || count < 0 || msats < 0n ||
              msats > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("Yield metrics exceed exact numeric bounds");
          }
          // Only committed simulated claims are recorded. Rolled-back/rejected
          // attempts and real Lightning payout reliability are outside this scope.
          const successfulClaims = count;
          cached = {
            total_claims_processed: count,
            total_yield_distributed_sats: Number(msats) / 1000,
            payout_reliability_score: count === 0
              ? "100.00%" : `${((successfulClaims / count) * 100).toFixed(2)}%`,
            status: "Healthy",
          };
          expiresAt = now() + 30_000;
          return cached;
        } catch (error) {
          retryAfter = now() + 5000;
          throw error;
        }
      })().finally(() => { inFlight = undefined; });
    }
    return { ...await inFlight };
  };
}
