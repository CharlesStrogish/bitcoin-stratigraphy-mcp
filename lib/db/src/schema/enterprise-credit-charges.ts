import { integer, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const enterpriseCreditChargesTable = pgTable(
  "enterprise_credit_charges",
  {
    eventId: text("event_id").primaryKey(),
    pubkey: text("pubkey").notNull(),
    // Nullable for legacy charges and the Commander's own admissions.
    workerPubkey: text("worker_pubkey"),
    sessionId: text("session_id").notNull(),
    requestHash: text("request_hash").notNull(),
    amountSats: integer("amount_sats").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("enterprise_credit_charges_worker_idx").on(
      table.pubkey,
      table.workerPubkey,
    ),
    index("enterprise_credit_charges_session_idx").on(
      table.pubkey,
      table.sessionId,
    ),
  ],
);
export const insertEnterpriseCreditChargeSchema = createInsertSchema(
  enterpriseCreditChargesTable,
);
export type InsertEnterpriseCreditCharge = z.infer<
  typeof insertEnterpriseCreditChargeSchema
>;
export type EnterpriseCreditCharge =
  typeof enterpriseCreditChargesTable.$inferSelect;
