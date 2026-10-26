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
  state: CreditState;
};
export interface CreditTransaction {
  account: CreditAccount;
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
  ): Promise<T>;
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
    async transaction(pubkey, run) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
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
          `UPDATE enterprise_credit_accounts SET trust_score=$2,unpaid_sats=$3,state=$4::jsonb WHERE pubkey=$1`,
          [
            pubkey,
            account.trust_score,
            account.unpaid_sats,
            JSON.stringify(account.state),
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
