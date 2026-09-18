import { pool } from "@workspace/db";
import type {
  PaymentChallengeStore,
  ChallengeStorePolicy,
} from "./payment-challenge-store";

type ChallengeRow = {
  invoice_attempted_at: number[];
};
type RangeChallengeRow = {
  invoice: string;
  payment_hash: string;
  provider: string;
  asset: "btc-lightning" | "l-btc" | "taproot-assets";
  redeem_until: Date;
  expires_at: Date;
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
    async getOrCreate(caller, scope, policy, create, scopeForChallenge) {
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
          "DELETE FROM payment_range_challenges WHERE expires_at <= $1",
          [new Date(now)],
        );
        await client.query(
          "DELETE FROM payment_invoice_bindings WHERE redeem_until <= $1",
          [new Date(now)],
        );
        await client.query(
          "DELETE FROM payment_challenges WHERE expires_at <= $1",
          [new Date(now)],
        );
        const result = await client.query<ChallengeRow>(
          `SELECT invoice_attempted_at
             FROM payment_challenges WHERE caller_key = $1 FOR UPDATE`,
          [caller],
        );
        const row = result.rows[0];
        const attempts = (row?.invoice_attempted_at ?? []).filter(
          (attemptedAt) => now - attemptedAt < policy.limitWindowMs,
        );

        const challengeResult = await client.query<RangeChallengeRow>(
          `SELECT invoice, payment_hash, provider, expires_at
             FROM payment_range_challenges
            WHERE caller_key = $1 AND scope = $2 FOR UPDATE`,
          [caller, scope],
        );
        const existingChallenge = challengeResult.rows[0];
        if (existingChallenge?.expires_at.getTime() > now) {
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            kind: "challenge",
            challenge: {
              invoice: existingChallenge.invoice,
              paymentHash: existingChallenge.payment_hash,
              provider: existingChallenge.provider,
              issuedAt:
                existingChallenge.expires_at.getTime() - policy.reuseMs,
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
        const finalScope = scopeForChallenge?.(challenge) ?? scope;
        const createdAt = policy.now();
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query(
          `INSERT INTO payment_invoice_bindings
             (caller_key, payment_hash, provider, asset, redeem_until)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (caller_key, payment_hash) DO UPDATE SET
             provider = EXCLUDED.provider,
             asset = EXCLUDED.asset,
             redeem_until = EXCLUDED.redeem_until`,
          [
            caller,
            challenge.paymentHash,
            challenge.provider ?? "legacy-unbound",
            challenge.asset ?? "btc-lightning",
            new Date(challenge.redeemUntil ?? createdAt + 60 * 60 * 1000),
          ],
        );
        await client.query(
          `INSERT INTO payment_range_challenges
             (caller_key, scope, invoice, payment_hash, provider, expires_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (caller_key, scope) DO UPDATE SET
             invoice = EXCLUDED.invoice,
             payment_hash = EXCLUDED.payment_hash,
              provider = EXCLUDED.provider,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [
            caller,
            finalScope,
            challenge.invoice,
            challenge.paymentHash,
            challenge.provider ?? "legacy-unbound",
            new Date(createdAt + policy.reuseMs),
          ],
        );
        if (finalScope !== scope) {
          await client.query(
            `INSERT INTO payment_range_challenges
               (caller_key, scope, invoice, payment_hash, provider, expires_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (caller_key, scope) DO UPDATE SET
               invoice = EXCLUDED.invoice,
               payment_hash = EXCLUDED.payment_hash,
                provider = EXCLUDED.provider,
               expires_at = EXCLUDED.expires_at,
               updated_at = NOW()`,
            [
              caller,
              scope,
              challenge.invoice,
              challenge.paymentHash,
              challenge.provider ?? "legacy-unbound",
              new Date(createdAt + policy.reuseMs),
            ],
          );
        }
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
    async consume(caller, scope, paymentHash) {
      await databasePool.query(
        `DELETE FROM payment_range_challenges
          WHERE caller_key = $1
             AND (scope = $2 OR scope LIKE $2 || ':%')
            AND payment_hash = $3`,
        [caller, scope, paymentHash],
      );
    },
    async findByPaymentHash(caller, paymentHash) {
      const result = await databasePool.query<RangeChallengeRow>(
        `SELECT payment_hash, provider, asset, redeem_until
           FROM payment_invoice_bindings
          WHERE caller_key = $1
            AND payment_hash = $2
            AND redeem_until > NOW()
          LIMIT 1`,
        [caller, paymentHash],
      );
      const row = result.rows[0];
      return row
        ? {
            invoice: "",
            paymentHash: row.payment_hash,
            provider: row.provider,
            asset: row.asset,
            issuedAt: 0,
            redeemUntil: row.redeem_until.getTime(),
          }
        : null;
    },
  };
}