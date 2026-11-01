import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const privateYieldClaimsTable = pgTable("private_yield_claims", {
  id: text("id").primaryKey(),
  invoicePaymentHash: text("invoice_payment_hash").notNull(),
  invoiceDigest: text("invoice_digest").notNull(),
  totalMsats: bigint("total_msats", { mode: "bigint" }).notNull(),
  settlementMode: text("settlement_mode").notNull().default("mock"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("private_yield_claim_invoice_uidx").on(table.invoicePaymentHash),
  check("private_yield_claim_mock_only", sql`${table.settlementMode} = 'mock' AND ${table.totalMsats} > 0`),
]);

export const privateYieldEarningsTable = pgTable("private_yield_earnings", {
  paymentHash: text("payment_hash").primaryKey(),
  provider: text("provider").notNull(),
  grossMsats: bigint("gross_msats", { mode: "bigint" }).notNull(),
  earnedMsats: bigint("earned_msats", { mode: "bigint" }).notNull(),
  balanceMsats: bigint("balance_msats", { mode: "bigint" }).notNull(),
  claimId: text("claim_id").references(() => privateYieldClaimsTable.id),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, (table) => [
  check("private_yield_earnings_arithmetic", sql`${table.grossMsats} > 0 AND ${table.earnedMsats} = ${table.grossMsats} * 21 / 100 AND ${table.earnedMsats} > 0`),
  check("private_yield_earnings_consumption", sql`(${table.claimId} IS NULL AND ${table.claimedAt} IS NULL AND ${table.balanceMsats} = ${table.earnedMsats}) OR (${table.claimId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.balanceMsats} = 0)`),
]);
