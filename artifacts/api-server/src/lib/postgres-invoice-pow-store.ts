// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { pool } from "@workspace/db";
import { logger } from "./logger";

export interface InvoicePowStore {
  consume(challengeId: string, expiresAt: number): Promise<boolean>;
  purgeExpired(): Promise<void>;
}

export function createPostgresInvoicePowStore(
  database: Pick<typeof pool, "query"> = pool,
): InvoicePowStore {
  return {
    async consume(challengeId, expiresAt) {
      // A single unique INSERT is the global reservation. Await its commit
      // before contacting the wallet; conflicts (including races) lose.
      // pg supports per-query timeouts at runtime; QueryConfig's typings omit it.
      const query = {
        text: `INSERT INTO invoice_pow_consumptions (challenge_id, expires_at)
          SELECT $1, to_timestamp($2::double precision / 1000)
          WHERE to_timestamp($2::double precision / 1000) > clock_timestamp()
          ON CONFLICT (challenge_id) DO NOTHING
          RETURNING challenge_id`,
        values: [challengeId, expiresAt],
        query_timeout: 3_000,
      };
      const result = await database.query(query);
      return result.rows.length === 1;
    },
    async purgeExpired() {
      const query = {
        text: `DELETE FROM invoice_pow_consumptions
          WHERE expires_at <= clock_timestamp()`,
        query_timeout: 3_000,
      };
      await database.query(query);
    },
  };
}

export const postgresInvoicePowStore = createPostgresInvoicePowStore();

/** Startup + periodic cleanup runs even without requests. No startup DDL,
 * overlapping sweeps, or referenced timer that prevents process shutdown.
 */
export function startInvoicePowCleanup(
  store: InvoicePowStore = postgresInvoicePowStore,
  intervalMs = 30_000,
  onError: (error: unknown) => void = (error) =>
    logger.warn({ err: error }, "Invoice proof expiry cleanup failed"),
): () => Promise<void> {
  let stopping = false;
  let pending: Promise<void> | undefined;
  const sweep = () => {
    if (stopping || pending) return;
    pending = Promise.resolve()
      .then(() => store.purgeExpired())
      .catch(onError)
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  sweep();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await pending;
  };
}
