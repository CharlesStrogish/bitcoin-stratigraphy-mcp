import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import {
  goalProgress,
  sanitizeLedgerEntry,
  validateLedgerEntry,
  type RevenueChannelBreakdown,
  type RevenueLedger,
  type RevenueLedgerEntry,
  type SanitizedRevenueLedgerEntry,
} from "./ledger";

type DatabasePool = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
};

function encrypt(value: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError("Database returned an invalid revenue total");
  }
  return parsed;
}

export function createPostgresRevenueLedger(
  databasePool: DatabasePool = pool,
  secret = process.env.SESSION_SECRET,
): RevenueLedger {
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is required to encrypt revenue ledger data",
    );
  }
  return {
    async record(entry) {
      validateLedgerEntry(entry);
      const result = await databasePool.query<{ id: string }>(
        `INSERT INTO revenue_ledger
           (id, timestamp, channel, request_kind, sats_received,
            payment_hash, preimage, client_identifier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (payment_hash) DO NOTHING
         RETURNING id`,
        [
          entry.id,
          entry.timestamp,
          entry.channel,
          entry.requestKind,
          entry.satsReceived,
          entry.paymentHash.toLowerCase(),
          // Legacy encrypted proof column also stores CoinOS payment IDs;
          // the entry type keeps references distinct from true preimages.
          encrypt(
            (entry.preimage ?? entry.coinosPaymentId).toLowerCase(),
            secret,
          ),
          encrypt(entry.clientIdentifier, secret),
        ],
      );
      return result.rows.length === 1;
    },
    async getDailyVolume() {
      const result = await databasePool.query<{ total: string }>(
        `SELECT COALESCE(SUM(sats_received), 0)::text AS total
         FROM revenue_ledger
         WHERE timestamp >= NOW() - INTERVAL '24 hours'
           AND timestamp <= NOW()`,
      );
      return integer(result.rows[0]?.total ?? "0");
    },
    async getTotalVolume() {
      const result = await databasePool.query<{ total: string }>(
        `SELECT COALESCE(SUM(sats_received), 0)::text AS total
         FROM revenue_ledger`,
      );
      return integer(result.rows[0]?.total ?? "0");
    },
    async getChannelBreakdown() {
      const result = await databasePool.query<{
        channel: string;
        total: string;
      }>(
        `SELECT channel, SUM(sats_received)::text AS total
         FROM revenue_ledger
         GROUP BY channel`,
      );
      const breakdown: RevenueChannelBreakdown = { "NIP-90": 0, L402: 0 };
      for (const row of result.rows) {
        if (row.channel === "NIP-90" || row.channel === "L402") {
          breakdown[row.channel] = integer(row.total);
        }
      }
      return breakdown;
    },
    async getGoalProgress(targetSats = 500_000) {
      return goalProgress(await this.getDailyVolume(), targetSats);
    },
    async getRecent(limit = 100) {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const result = await databasePool.query<{
        id: string;
        timestamp: Date | string;
        channel: "NIP-90" | "L402";
        request_kind: "stratigraphy" | "zk-proof";
        sats_received: string | number;
        payment_hash: string;
      }>(
        `SELECT id, timestamp, channel, request_kind, sats_received,
                payment_hash
         FROM revenue_ledger
         ORDER BY timestamp DESC
         LIMIT $1`,
        [safeLimit],
      );
      return result.rows.map((row): SanitizedRevenueLedgerEntry =>
        sanitizeLedgerEntry({
          id: row.id,
          timestamp: new Date(row.timestamp).toISOString(),
          channel: row.channel,
          requestKind: row.request_kind,
          satsReceived: integer(row.sats_received),
          paymentHash: row.payment_hash,
          preimage: "00".repeat(32),
          clientIdentifier: "redacted",
        }),
      );
    },
  };
}

export type { RevenueLedgerEntry };
