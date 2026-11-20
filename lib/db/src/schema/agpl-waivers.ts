import { bigint, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
});
export const agplWaiverCertificatesTable = pgTable("agpl_waiver_certificates", {
  id: text("id").primaryKey(),
  quoteId: text("quote_id").notNull().unique().references(() => agplWaiverQuotesTable.id),
  txid: text("txid").notNull(),
  vout: integer("vout").notNull(),
  certificate: jsonb("certificate").notNull(),
}, table => [uniqueIndex("agpl_waiver_txid_vout_unique").on(table.txid, table.vout)]);
