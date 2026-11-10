import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Application fulfillment only. Stripe owns its own product/payment records. */
export const fiatMintOrdersTable = pgTable(
  "fiat_mint_orders",
  {
    id: text("id").primaryKey(),
    ownerHash: text("owner_hash").notNull().unique(),
    status: text("status").notNull().default("checkout"),
    sessionId: text("session_id").unique(),
    invoice: text("invoice"),
    paymentHash: text("payment_hash").unique(),
    macaroon: text("macaroon"),
    validUntil: integer("valid_until"),
    reservedSats: integer("reserved_sats").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("fiat_mint_status_idx").on(table.status)],
);

export const insertFiatMintOrderSchema =
  createInsertSchema(fiatMintOrdersTable);
export type InsertFiatMintOrder = z.infer<typeof insertFiatMintOrderSchema>;
export type FiatMintOrder = typeof fiatMintOrdersTable.$inferSelect;
