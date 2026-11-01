import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const privateYieldClaimsTable = pgTable("private_yield_claims", {
  id: text("id").primaryKey(),
  invoicePaymentHash: text("invoice_payment_hash").notNull(),
  invoiceDigest: text("invoice_digest").notNull(),
  totalMsats: bigint("total_msats", { mode: "bigint" }).notNull(),
  settlementMode: text("settlement_mode").notNull().default("mainnet"),
  paymentStatus: text("payment_status").notNull().default("pending"),
  coinosTxid: text("coinos_txid"),
  preimage: text("preimage"),
  failureCode: text("failure_code"),
  selectionDigest: text("selection_digest"),
  receiptCount: integer("receipt_count").notNull().default(0),
  attempt: integer("attempt").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("private_yield_claim_invoice_uidx").on(table.invoicePaymentHash),
  check("private_yield_claim_payment_state", sql`${table.settlementMode} IN ('mock','mainnet') AND ${table.totalMsats} > 0 AND ${table.paymentStatus} IN ('pending','settled','failed') AND (${table.settlementMode} <> 'mainnet' OR ${table.paymentStatus} <> 'settled' OR ${table.coinosTxid} IS NOT NULL OR ${table.preimage} IS NOT NULL)`),
]);

export const privateYieldPayoutItemsTable = pgTable("private_yield_payout_items", {
  source: text("source").notNull(),
  paymentHash: text("payment_hash").notNull(),
  claimId: text("claim_id").notNull().references(() => privateYieldClaimsTable.id),
}, table => [
  primaryKey({ columns: [table.source, table.paymentHash] }),
  index("private_yield_payout_claim_idx").on(table.claimId),
  check("private_yield_payout_source", sql`${table.source} IN ('yield','royalty')`),
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
