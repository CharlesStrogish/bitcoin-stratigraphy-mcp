// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Only solved challenges are stored; unverified requests allocate no rows. */
export const invoicePowConsumptionsTable = pgTable(
  "invoice_pow_consumptions",
  {
    challengeId: text("challenge_id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("invoice_pow_consumptions_expiry_idx").on(table.expiresAt)],
);
export const insertInvoicePowConsumptionSchema = createInsertSchema(
  invoicePowConsumptionsTable,
);
export type InsertInvoicePowConsumption = z.infer<
  typeof insertInvoicePowConsumptionSchema
>;
export type InvoicePowConsumption =
  typeof invoicePowConsumptionsTable.$inferSelect;
