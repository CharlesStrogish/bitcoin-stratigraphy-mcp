// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { pool } from "@workspace/db";

export type EnterpriseAccount = {
  buyer: string;
  total_msats: string;
  qualifying_msats: string;
  grant?: { iat: number; exp: number; threshold_price_usd_cents: number };
};
export type RoutingInvoice = {
  hash: string;
  provider: string;
  amount_msats: string;
  buyer?: string;
  payout?: string;
  parent_payout?: string;
  kickback_msats: string;
  direct_kickback_msats?: string;
  parent_kickback_msats?: string;
  allocation: Record<string, unknown>;
  settled_at?: string;
};
export interface EconomicsTransaction {
  routingVolume(payout: string): Promise<string>;
  invoice(hash: string): Promise<RoutingInvoice | undefined>;
  putInvoice(invoice: RoutingInvoice): Promise<void>;
  account(buyer: string): Promise<EnterpriseAccount>;
  putAccount(account: EnterpriseAccount): Promise<void>;
}
export interface EnterpriseEconomicsStore {
  transaction<T>(
    key: string,
    run: (tx: EconomicsTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Atomic reference adapter, used only by tests/self-contained integrations. */
export function createMemoryEnterpriseEconomicsStore(): EnterpriseEconomicsStore {
  let invoices = new Map<string, RoutingInvoice>();
  let accounts = new Map<string, EnterpriseAccount>();
  let tail = Promise.resolve();
  return {
    async transaction(_key, run) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const nextInvoices = structuredClone(invoices);
      const nextAccounts = structuredClone(accounts);
      try {
        const result = await run({
          routingVolume: async (payout) =>
            [...nextInvoices.values()]
              .filter(
                (invoice) => invoice.payout === payout && invoice.settled_at,
              )
              .reduce(
                (total, invoice) => total + BigInt(invoice.amount_msats),
                0n,
              )
              .toString(),
          invoice: async (hash) => structuredClone(nextInvoices.get(hash)),
          putInvoice: async (invoice) => {
            nextInvoices.set(invoice.hash, structuredClone(invoice));
          },
          account: async (buyer) =>
            structuredClone(
              nextAccounts.get(buyer) ?? {
                buyer,
                total_msats: "0",
                qualifying_msats: "0",
              },
            ),
          putAccount: async (account) => {
            nextAccounts.set(account.buyer, structuredClone(account));
          },
        });
        invoices = nextInvoices;
        accounts = nextAccounts;
        return result;
      } finally {
        release();
      }
    },
  };
}

/** All monetary counters are integer millisatoshis; no payment preimages are stored. */
export function createPostgresEnterpriseEconomicsStore(
  database = pool,
): EnterpriseEconomicsStore {
  let initialized: Promise<unknown> | undefined;
  const initialize = () =>
    (initialized ??= database
      .query(
        `
    CREATE TABLE IF NOT EXISTS enterprise_routing_invoices (
      payment_hash text PRIMARY KEY, payload jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enterprise_buyer_accounts (
      buyer_pubkey text PRIMARY KEY, payload jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS enterprise_settled_routing_payout
      ON enterprise_routing_invoices ((payload->>'payout'))
      WHERE payload->>'settled_at' IS NOT NULL`,
      )
      .catch((error) => {
        initialized = undefined;
        throw error;
      }));
  return {
    async transaction(key, run) {
      await initialize();
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["enterprise:" + key],
        );
        const result = await run({
          async routingVolume(payout) {
            const result = await client.query<{ total: string }>(
              `SELECT COALESCE(SUM((payload->>'amount_msats')::numeric),0)::text AS total
               FROM enterprise_routing_invoices
               WHERE payload->>'payout'=$1 AND payload->>'settled_at' IS NOT NULL`,
              [payout],
            );
            if (!result.rows[0]) throw new Error("Routing volume unavailable");
            return result.rows[0].total;
          },
          async invoice(hash) {
            const result = await client.query<{ payload: RoutingInvoice }>(
              "SELECT payload FROM enterprise_routing_invoices WHERE payment_hash=$1 FOR UPDATE",
              [hash],
            );
            return result.rows[0]?.payload;
          },
          async putInvoice(invoice) {
            await client.query(
              `INSERT INTO enterprise_routing_invoices VALUES ($1,$2::jsonb)
              ON CONFLICT (payment_hash) DO UPDATE SET payload=EXCLUDED.payload`,
              [invoice.hash, JSON.stringify(invoice)],
            );
          },
          async account(buyer) {
            const empty: EnterpriseAccount = {
              buyer,
              total_msats: "0",
              qualifying_msats: "0",
            };
            await client.query(
              `INSERT INTO enterprise_buyer_accounts VALUES ($1,$2::jsonb)
              ON CONFLICT DO NOTHING`,
              [buyer, JSON.stringify(empty)],
            );
            const result = await client.query<{ payload: EnterpriseAccount }>(
              "SELECT payload FROM enterprise_buyer_accounts WHERE buyer_pubkey=$1 FOR UPDATE",
              [buyer],
            );
            if (!result.rows[0])
              throw new Error("Enterprise account unavailable");
            return result.rows[0].payload;
          },
          async putAccount(account) {
            await client.query(
              "UPDATE enterprise_buyer_accounts SET payload=$2::jsonb WHERE buyer_pubkey=$1",
              [account.buyer, JSON.stringify(account)],
            );
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
