import { check, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const enterpriseCreditAccountsTable = pgTable(
  "enterprise_credit_accounts",
  {
    pubkey: text("pubkey").primaryKey(),
    trustScore: integer("trust_score").notNull().default(0),
    unpaidSats: integer("unpaid_sats").notNull().default(0),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    check(
      "enterprise_credit_accounts_balance_check",
      sql`${table.unpaidSats} >= 0 AND ${table.unpaidSats} <= 2000`,
    ),
    check(
      "enterprise_credit_accounts_trust_check",
      sql`${table.trustScore} >= 0`,
    ),
  ],
);
export const insertEnterpriseCreditAccountSchema = createInsertSchema(
  enterpriseCreditAccountsTable,
);
export type InsertEnterpriseCreditAccount = z.infer<
  typeof insertEnterpriseCreditAccountSchema
>;
export type EnterpriseCreditAccount =
  typeof enterpriseCreditAccountsTable.$inferSelect;
