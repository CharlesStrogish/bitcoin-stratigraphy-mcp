import { bigint, integer, jsonb, pgSequence, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const agplWaiverDerivationSequence = pgSequence("agpl_waiver_derivation_seq", {
  startWith: 0, minValue: 0, maxValue: 2147483647, cycle: false,
});
export const agplWaiverQuoteLimitsTable = pgTable("agpl_waiver_quote_limits", {
  clientKey: text("client_key").primaryKey(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  quoteCount: integer("quote_count").notNull(),
});

export const agplWaiverQuotesTable = pgTable("agpl_waiver_quotes", {
  id: text("id").primaryKey(),
  tier: text("tier").notNull(),
  licenseeName: text("licensee_name").notNull(),
  licenseeIdentifier: text("licensee_identifier").notNull(),
  usdBasis: integer("usd_basis").notNull(),
  quotedSats: bigint("quoted_sats", { mode: "number" }).notNull(),
  btcSpotUsd: text("btc_spot_usd").notNull(),
  settlementAddress: text("settlement_address").notNull(),
  minConfirmations: integer("min_confirmations").notNull(),
  termsSha256: text("terms_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  derivationIndex: integer("derivation_index").unique(),
}, table => [uniqueIndex("agpl_waiver_derived_address_unique").on(table.settlementAddress)
  .where(sql`${table.derivationIndex} IS NOT NULL`)]);
export const agplWaiverCertificatesTable = pgTable("agpl_waiver_certificates", {
  id: text("id").primaryKey(),
  quoteId: text("quote_id").notNull().unique().references(() => agplWaiverQuotesTable.id),
  txid: text("txid").notNull(),
  vout: integer("vout").notNull(),
  certificate: jsonb("certificate").notNull(),
  derivationIndex: integer("derivation_index").unique(),
}, table => [uniqueIndex("agpl_waiver_txid_vout_unique").on(table.txid, table.vout)]);
