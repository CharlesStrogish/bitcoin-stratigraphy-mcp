import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// A transaction-locked snapshot preserves the Python engine's exact custody and
// RFC 6962 leaf ordering without making a container-local SQLite file authoritative.
export const escrowLedgerTable = pgTable("escrow_ledger", {
  id: text("id").primaryKey(),
  state: jsonb("state"),
  genesis: jsonb("genesis").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertEscrowLedgerSchema = createInsertSchema(escrowLedgerTable);
export type EscrowLedgerRow = typeof escrowLedgerTable.$inferSelect;
