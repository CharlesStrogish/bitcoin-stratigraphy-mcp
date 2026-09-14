import { pool } from "@workspace/db";
import type {
  PaymentChallengeStore,
  ChallengeStorePolicy,
} from "./payment-challenge-store";

type ChallengeRow = {
  invoice: string | null;
  payment_hash: string | null;
  challenge_expires_at: Date | null;
  invoice_attempted_at: number[];
};
type QueryResult<Row> = { rows: Row[] };
type DatabaseClient = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
};
type DatabasePool = {
  connect(): Promise<DatabaseClient>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
};

function retryAfter(
  now: number,
  oldestAttempt: number,
  policy: ChallengeStorePolicy,
) {
  return Math.max(
    1,
    Math.ceil(
      (policy.limitWindowMs - (now - oldestAttempt)) / 1000,
    ),
  );
}

export function createPostgresPaymentChallengeStore(
  databasePool: DatabasePool = pool,
): PaymentChallengeStore {
  return {
    async checkHealth() {
      await databasePool.query("SELECT 1");
    },
    async getOrCreate(caller, policy, create) {
      const client = await databasePool.connect();
      let transactionOpen = false;
      let callerLocked = false;
      let capacityLocked = false;
      try {
        await client.query(
          "SELECT pg_advisory_lock(hashtextextended('payment-challenge-caller:' || $1, 0))",
          [caller],
        );
        callerLocked = true;
        await client.query("BEGIN");
        transactionOpen = true;
        const now = policy.now();
        await client.query(
          "DELETE FROM payment_challenges WHERE expires_at <= $1",
          [new Date(now)],
        );
        const result = await client.query<ChallengeRow>(
          `SELECT invoice, payment_hash, challenge_expires_at, invoice_attempted_at
             FROM payment_challenges WHERE caller_key = $1 FOR UPDATE`,
          [caller],
        );
        const row = result.rows[0];
        const attempts = (row?.invoice_attempted_at ?? []).filter(
          (attemptedAt) => now - attemptedAt < policy.limitWindowMs,
        );

        if (
          row?.invoice &&
          row.payment_hash &&
          row.challenge_expires_at &&
          row.challenge_expires_at.getTime() > now
        ) {
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            kind: "challenge",
            challenge: {
              invoice: row.invoice,
              paymentHash: row.payment_hash,
            },
          };
        }

        if (!row) {
          await client.query(
            "SELECT pg_advisory_lock(hashtextextended('payment-challenge-capacity', 0))",
          );
          capacityLocked = true;
          const count = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM payment_challenges",
          );
          if (Number(count.rows[0]?.count ?? 0) >= policy.maxCallers) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return { kind: "limited", retryAfter: 60 };
          }
        }
        if (attempts.length >= policy.maxInvoicesPerWindow) {
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            kind: "limited",
            retryAfter: retryAfter(now, attempts[0], policy),
          };
        }

        attempts.push(now);
        await client.query(
          `INSERT INTO payment_challenges
             (caller_key, invoice_attempted_at, expires_at, updated_at)
           VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (caller_key) DO UPDATE SET
             invoice = NULL,
             payment_hash = NULL,
             challenge_expires_at = NULL,
             invoice_attempted_at = EXCLUDED.invoice_attempted_at,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [
            caller,
            JSON.stringify(attempts),
            new Date(now + policy.limitWindowMs),
          ],
        );
        await client.query("COMMIT");
        transactionOpen = false;
        if (capacityLocked) {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended('payment-challenge-capacity', 0))",
          );
          capacityLocked = false;
        }

        const challenge = await create();
        const createdAt = policy.now();
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query(
          `UPDATE payment_challenges SET
             invoice = $2,
             payment_hash = $3,
             challenge_expires_at = $4,
             expires_at = $5,
             updated_at = NOW()
           WHERE caller_key = $1`,
          [
            caller,
            challenge.invoice,
            challenge.paymentHash,
            new Date(createdAt + policy.reuseMs),
            new Date(
              Math.max(
                createdAt + policy.reuseMs,
                attempts.at(-1)! + policy.limitWindowMs,
              ),
            ),
          ],
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return { kind: "challenge", challenge };
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        throw error;
      } finally {
        if (capacityLocked) {
          await client
            .query(
              "SELECT pg_advisory_unlock(hashtextextended('payment-challenge-capacity', 0))",
            )
            .catch(() => undefined);
        }
        if (callerLocked) {
          await client
            .query(
              "SELECT pg_advisory_unlock(hashtextextended('payment-challenge-caller:' || $1, 0))",
              [caller],
            )
            .catch(() => undefined);
        }
        client.release();
      }
    },
    async consume(caller, paymentHash) {
      await databasePool.query(
        `DELETE FROM payment_challenges
          WHERE caller_key = $1 AND payment_hash = $2`,
        [caller, paymentHash],
      );
    },
  };
}