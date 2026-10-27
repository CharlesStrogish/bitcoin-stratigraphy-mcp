import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

export type TabInvoice = {
  paymentHash: string;
  provider: string;
  invoice: string;
  macaroon: string;
  amountSats: number;
  description: string;
  expiresAt: number;
  grossAmountSats?: number;
  yieldAppliedMsats?: number;
};
export type CreditState = {
  sessionId: string;
  due: boolean;
  lastActivity: number;
  invoices: TabInvoice[];
  routing?: {
    payout?: string;
    parentPayout?: string;
    verificationAllocation?: {
      origin_pubkey: string;
      proof_hash: string;
      caller_pubkey: string;
    };
  };
};
export type CreditAccount = {
  pubkey: string;
  trust_score: number;
  unpaid_sats: number;
  yield_credit_msats: number;
  state: CreditState;
};
export interface CreditTransaction {
  account: CreditAccount;
  updateFleet?(
    add: string[],
    remove: string[],
    eventId: string,
  ): Promise<string[]>;
  paid(
    hash: string,
  ): Promise<
    | { pubkey: string; source: string; provider: string; amount_sats: number }
    | undefined
  >;
  recordPaid(
    hash: string,
    provider: string,
    amount: number,
    source: string,
  ): Promise<boolean>;
  charge(
    eventId: string,
    requestHash: string,
    amount: number,
  ): Promise<boolean>;
}
export interface EnterpriseCreditStore {
  transaction<T>(
    pubkey: string,
    run: (tx: CreditTransaction) => Promise<T>,
    options?: { routeFleet?: boolean; manageFleet?: boolean },
  ): Promise<T>;
}

export class FleetStoreError extends Error {
  readonly status = 409;
}

export function newCreditState(now = Date.now()): CreditState {
  return {
    sessionId: randomUUID(),
    due: false,
    lastActivity: now,
    invoices: [],
  };
}
export function createPostgresEnterpriseCreditStore(
  database = pool,
): EnterpriseCreditStore {
  return {
    async transaction(pubkey, run, options) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        // Only administrative mutations take this lock. This prevents cycles
        // and competing ownership without serializing tool requests globally.
        if (options?.manageFleet)
          await client.query("SELECT pg_advisory_xact_lock(736421, 1)");
        const signer = pubkey;
        if (options?.routeFleet) {
          const owner = await client.query<{ commander_pubkey: string }>(
            "SELECT commander_pubkey FROM enterprise_credit_fleet WHERE worker_pubkey=$1",
            [signer],
          );
          pubkey = owner.rows[0]?.commander_pubkey ?? signer;
        }
        const inserted = await client.query(
          `INSERT INTO enterprise_credit_accounts(pubkey,state) VALUES ($1,$2::jsonb)
           ON CONFLICT DO NOTHING RETURNING pubkey`,
          [pubkey, JSON.stringify(newCreditState())],
        );
        const result = await client.query<CreditAccount>(
          "SELECT * FROM enterprise_credit_accounts WHERE pubkey=$1 FOR UPDATE",
          [pubkey],
        );
        const account = result.rows[0]!;
        if (options?.routeFleet) {
          // Membership changes take the same owner account lock. Recheck after
          // acquiring it so removal cannot race a charge based on stale routing.
          const owner = await client.query<{ commander_pubkey: string }>(
            "SELECT commander_pubkey FROM enterprise_credit_fleet WHERE worker_pubkey=$1",
            [signer],
          );
          if ((owner.rows[0]?.commander_pubkey ?? signer) !== pubkey)
            throw new FleetStoreError(
              "Fleet routing changed; retry with a fresh NIP-98 signature",
            );
        }
        if (inserted.rows.length) {
          // Historical routing invoices carry a buyer only after verified NIP-98.
          // Never infer reputation from a bare agent_id, quote, or usage count.
          await client.query(
            `INSERT INTO enterprise_credit_settlements(payment_hash,pubkey,provider,amount_sats,source)
             SELECT payment_hash,$1,payload->>'provider',((payload->>'amount_msats')::bigint / 1000)::integer,'historical-l402'
             FROM enterprise_routing_invoices
             WHERE payload->>'buyer'=$1 AND payload->>'settled_at' IS NOT NULL
               AND payment_hash ~ '^[0-9a-f]{64}$'
               AND payload->>'provider' IS NOT NULL
               AND (payload->>'amount_msats')::bigint BETWEEN 1000 AND 2147483647000
             ON CONFLICT DO NOTHING`,
            [pubkey],
          );
          const count = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM enterprise_credit_settlements WHERE pubkey=$1",
            [pubkey],
          );
          account.trust_score = Number(count.rows[0]!.count);
        }
        const value = await run({
          account,
          async updateFleet(add, remove, eventId) {
            if (!options?.manageFleet)
              throw new Error(
                "Fleet mutation requires administrative transaction",
              );
            const nested = await client.query(
              `SELECT worker_pubkey FROM enterprise_credit_fleet
               WHERE worker_pubkey=$1 OR commander_pubkey=ANY($2::text[]) LIMIT 1`,
              [pubkey, add],
            );
            if (nested.rows.length)
              throw new FleetStoreError("Nested fleets are not permitted");
            const conflicting = await client.query(
              `SELECT worker_pubkey FROM enterprise_credit_fleet
               WHERE worker_pubkey=ANY($1::text[]) AND commander_pubkey<>$2 LIMIT 1`,
              [add, pubkey],
            );
            if (conflicting.rows.length)
              throw new FleetStoreError(
                "Worker already belongs to another Commander",
              );
            const consumed = await client.query(
              `INSERT INTO enterprise_credit_fleet_updates(event_id,commander_pubkey)
               VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`,
              [eventId, pubkey],
            );
            if (!consumed.rows.length)
              throw new FleetStoreError(
                "Fleet registration signature already consumed",
              );
            await client.query(
              "DELETE FROM enterprise_credit_fleet WHERE commander_pubkey=$1 AND worker_pubkey=ANY($2::text[])",
              [pubkey, remove],
            );
            await client.query(
              `INSERT INTO enterprise_credit_fleet(worker_pubkey,commander_pubkey)
               SELECT unnest($1::text[]),$2 ON CONFLICT DO NOTHING`,
              [add, pubkey],
            );
            const fleet = await client.query<{ worker_pubkey: string }>(
              "SELECT worker_pubkey FROM enterprise_credit_fleet WHERE commander_pubkey=$1 ORDER BY worker_pubkey",
              [pubkey],
            );
            if (fleet.rows.length > 1000)
              throw new FleetStoreError("Fleet limit is 1000 Workers");
            return fleet.rows.map((row) => row.worker_pubkey);
          },
          async paid(hash) {
            return (
              await client.query(
                "SELECT pubkey,source,provider,amount_sats FROM enterprise_credit_settlements WHERE payment_hash=$1",
                [hash],
              )
            ).rows[0];
          },
          async recordPaid(hash, provider, amount, source) {
            const entry = await client.query(
              `INSERT INTO enterprise_credit_settlements(payment_hash,pubkey,provider,amount_sats,source,merchant_msats,allocation_pool_msats)
               VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING payment_hash`,
              [
                hash,
                pubkey,
                provider,
                amount,
                source,
                source === "credit-tab" ? amount * 790 : null,
                source === "credit-tab" ? amount * 210 : null,
              ],
            );
            if (entry.rows.length) account.trust_score++;
            return entry.rows.length === 1;
          },
          async charge(eventId, requestHash, amount) {
            return (
              (
                await client.query(
                  `INSERT INTO enterprise_credit_charges(event_id,pubkey,session_id,request_hash,amount_sats)
               VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
                  [
                    eventId,
                    pubkey,
                    account.state.sessionId,
                    requestHash,
                    amount,
                  ],
                )
              ).rows.length === 1
            );
          },
        });
        await client.query(
          `UPDATE enterprise_credit_accounts SET trust_score=$2,unpaid_sats=$3,state=$4::jsonb,yield_credit_msats=$5 WHERE pubkey=$1`,
          [
            pubkey,
            account.trust_score,
            account.unpaid_sats,
            JSON.stringify(account.state),
            account.yield_credit_msats,
          ],
        );
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
