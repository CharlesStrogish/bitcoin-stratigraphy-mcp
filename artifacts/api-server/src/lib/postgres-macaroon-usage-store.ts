import { pool } from "@workspace/db";
import type { MacaroonUsageStore } from "./macaroon-usage-store";

type DatabasePool = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  connect(): Promise<{
    query<Row = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Row[] }>;
    release(): void;
  }>;
};

export function createPostgresMacaroonUsageStore(
  databasePool: DatabasePool = pool,
): MacaroonUsageStore {
  let initialized: Promise<void> | undefined;
  const initialize = () => {
    initialized ??= databasePool
      .query(
        `CREATE TABLE IF NOT EXISTS macaroon_request_usage (
           token_id text PRIMARY KEY,
           request_count bigint NOT NULL,
           expires_at timestamptz NOT NULL
         )`,
      )
      .then(() => undefined);
    return initialized;
  };

  return {
    async consume(limits, validUntil) {
      await initialize();
      const client = await databasePool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM macaroon_request_usage WHERE expires_at <= NOW()",
        );
        for (const { tokenId } of [...limits].sort((a, b) =>
          a.tokenId.localeCompare(b.tokenId),
        )) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [tokenId],
          );
        }
        for (const { tokenId, maxRequests } of limits) {
          const result = await client.query<{ token_id: string }>(
            `INSERT INTO macaroon_request_usage
               (token_id, request_count, expires_at)
             VALUES ($1, 1, to_timestamp($3))
             ON CONFLICT (token_id) DO UPDATE SET
               request_count = macaroon_request_usage.request_count + 1,
               expires_at = GREATEST(
                 macaroon_request_usage.expires_at,
                 EXCLUDED.expires_at
               )
             WHERE macaroon_request_usage.request_count < $2
             RETURNING token_id`,
            [tokenId, maxRequests, validUntil],
          );
          if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return false;
          }
        }
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}