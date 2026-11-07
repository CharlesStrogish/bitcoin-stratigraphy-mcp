import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const yieldStakingAccountsTable = pgTable("yield_staking_accounts", {
  pubkeyHash: text("pubkey_hash").primaryKey(),
  stakedMsats: bigint("staked_msats", { mode: "bigint" }).notNull().default(0n),
  stakedSats: bigint("staked_sats", { mode: "bigint" })
    .generatedAlwaysAs(sql`staked_msats / 1000`),
}, table => [
  check("yield_staking_pubkey_hash", sql`${table.pubkeyHash} ~ '^[0-9a-f]{64}$'`),
  check("yield_staking_balance", sql`${table.stakedMsats} >= 0 AND ${table.stakedMsats} <= 9007199254740991`),
]);

export const yieldStakingReceiptsTable = pgTable("yield_staking_receipts", {
  paymentHash: text("payment_hash").primaryKey(),
  pubkeyHash: text("pubkey_hash").notNull().references(() => yieldStakingAccountsTable.pubkeyHash),
  provider: text("provider").notNull(),
  grossMsats: bigint("gross_msats", { mode: "bigint" }).notNull(),
  earnedMsats: bigint("earned_msats", { mode: "bigint" }).notNull(),
}, table => [
  check("yield_staking_payment_hash", sql`${table.paymentHash} ~ '^[0-9a-f]{64}$'`),
  check("yield_staking_arithmetic", sql`${table.grossMsats} > 0 AND ${table.grossMsats} <= 9007199254740991 AND ${table.earnedMsats} = ${table.grossMsats} * 21 / 100`),
]);

export const insertYieldStakingAccountSchema = createInsertSchema(yieldStakingAccountsTable);
export const insertYieldStakingReceiptSchema = createInsertSchema(yieldStakingReceiptsTable);
export type InsertYieldStakingAccount = z.infer<typeof insertYieldStakingAccountSchema>;
export type YieldStakingAccount = typeof yieldStakingAccountsTable.$inferSelect;
