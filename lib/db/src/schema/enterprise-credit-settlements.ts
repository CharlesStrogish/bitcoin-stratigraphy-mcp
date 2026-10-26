import { integer, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const enterpriseCreditSettlementsTable = pgTable(
  "enterprise_credit_settlements",
  {
    paymentHash: text("payment_hash").primaryKey(),
    pubkey: text("pubkey").notNull(),
    provider: text("provider").notNull(),
    amountSats: integer("amount_sats").notNull(),
    source: text("source").notNull(),
    merchantMsats: integer("merchant_msats"),
    allocationPoolMsats: integer("allocation_pool_msats"),
    settledAt: timestamp("settled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("enterprise_credit_settlements_pubkey_idx").on(table.pubkey),
  ],
);
export const insertEnterpriseCreditSettlementSchema = createInsertSchema(
  enterpriseCreditSettlementsTable,
);
export type InsertEnterpriseCreditSettlement = z.infer<
  typeof insertEnterpriseCreditSettlementSchema
>;
export type EnterpriseCreditSettlement =
  typeof enterpriseCreditSettlementsTable.$inferSelect;
