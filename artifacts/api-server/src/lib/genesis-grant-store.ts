// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

export const GENESIS_GRANT_LIMIT = 10;
export interface GenesisGrantReservation {
  remaining: number;
  complete(successful: boolean): Promise<void>;
}
export interface GenesisGrantStore {
  reserve(pubkey: string): Promise<GenesisGrantReservation | null>;
}

/**
 * Reservations consume capacity atomically across workers before tool execution.
 * Crashed workers leave their slots reserved (fail closed), never reissue them.
 * Only successful executions increase the lifetime counter; known failures refund.
 */
export function createPostgresGenesisGrantStore(
  database: Pick<typeof pool, "query"> = pool,
): GenesisGrantStore {
  return {
    async reserve(pubkey) {
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid grant pubkey");
      const id = randomUUID();
      const result = await database.query<{ remaining: number }>(
        `INSERT INTO genesis_grants (pubkey, reservations) VALUES ($1, ARRAY[$2]::text[])
         ON CONFLICT (pubkey) DO UPDATE
         SET reservations = array_append(genesis_grants.reservations, $2)
         WHERE genesis_grants.successful_calls + cardinality(genesis_grants.reservations) < 10
         RETURNING 10 - successful_calls - cardinality(reservations) AS remaining`,
        [pubkey, id],
      );
      const row = result.rows[0];
      if (!row) return null;
      let completion: Promise<void> | undefined;
      return {
        remaining: row.remaining,
        complete(successful) {
          // One decision per execution, including finish/error cleanup races.
          return completion ??= database.query(
            `UPDATE genesis_grants SET
               successful_calls = successful_calls + $3,
               reservations = array_remove(reservations, $2)
             WHERE pubkey = $1 AND $2 = ANY(reservations)`,
            [pubkey, id, successful ? 1 : 0],
          ).then(() => {});
        },
      };
    },
  };
}
