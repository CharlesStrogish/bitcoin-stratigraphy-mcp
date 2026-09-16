import { pool } from "@workspace/db";
import type {
  MacaroonRevocation,
  MacaroonRevocationStore,
} from "./macaroon-revocation-store";

type DatabasePool = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
};

type RevocationRow = {
  signature_id: string;
  revoked_at: Date;
  reason: string | null;
};

export function createPostgresMacaroonRevocationStore(
  databasePool: DatabasePool = pool,
): MacaroonRevocationStore {
  return {
    async isRevoked(signatureId) {
      const result = await databasePool.query<{ revoked: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM revoked_macaroons WHERE signature_id = $1
         ) AS revoked`,
        [signatureId],
      );
      return result.rows[0]?.revoked === true;
    },
    async revoke(signatureId, reason) {
      const result = await databasePool.query<RevocationRow>(
        `INSERT INTO revoked_macaroons (signature_id, reason)
         VALUES ($1, $2)
         ON CONFLICT (signature_id) DO UPDATE SET
           reason = COALESCE(revoked_macaroons.reason, EXCLUDED.reason)
         RETURNING signature_id, revoked_at, reason`,
        [signatureId, reason ?? null],
      );
      const row = result.rows[0];
      return {
        signatureId: row.signature_id,
        revokedAt: row.revoked_at,
        ...(row.reason ? { reason: row.reason } : {}),
      } satisfies MacaroonRevocation;
    },
  };
}