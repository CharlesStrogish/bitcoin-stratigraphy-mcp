import { pool } from "@workspace/db";

export interface Nip98RevocationStore {
  isRevoked(pubkey: string): Promise<boolean>;
  revoke(pubkey: string): Promise<{ pubkey: string; revoked_at: string }>;
}

export function normalizeNip98Pubkey(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("A 32-byte hexadecimal NIP-98 public key is required");
  }
  return value.toLowerCase();
}

type Database = Pick<typeof pool, "query">;

/** Shared persistent CRL; no positive cache, so the next request sees revocation. */
export function createPostgresNip98RevocationStore(
  database: Database = pool,
): Nip98RevocationStore {
  let initialized: Promise<unknown> | undefined;
  const initialize = () => {
    initialized ??= database.query(
      `CREATE TABLE IF NOT EXISTS revoked_nip98_keys (
         pubkey text PRIMARY KEY CHECK (pubkey ~ '^[0-9a-f]{64}$'),
         revoked_at timestamptz NOT NULL DEFAULT now()
       )`,
    ).catch((error: unknown) => {
      initialized = undefined;
      throw error;
    });
    return initialized;
  };
  return {
    async isRevoked(value) {
      const pubkey = normalizeNip98Pubkey(value);
      await initialize();
      const result = await database.query<{ revoked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM revoked_nip98_keys WHERE pubkey = $1) AS revoked",
        [pubkey],
      );
      if (typeof result.rows[0]?.revoked !== "boolean") {
        throw new Error("Revocation registry returned no decision");
      }
      return result.rows[0].revoked;
    },
    async revoke(value) {
      const pubkey = normalizeNip98Pubkey(value);
      await initialize();
      const result = await database.query<{ pubkey: string; revoked_at: Date }>(
        `INSERT INTO revoked_nip98_keys (pubkey) VALUES ($1)
         ON CONFLICT (pubkey) DO UPDATE SET pubkey = EXCLUDED.pubkey
         RETURNING pubkey, revoked_at`,
        [pubkey],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Revocation was not persisted");
      return { pubkey: row.pubkey, revoked_at: row.revoked_at.toISOString() };
    },
  };
}
