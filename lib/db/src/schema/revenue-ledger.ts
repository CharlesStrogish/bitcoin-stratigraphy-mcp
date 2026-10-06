import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const revenueLedgerTable = pgTable(
  "revenue_ledger",
  {
    id: text("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    channel: text("channel").notNull(),
    requestKind: text("request_kind").notNull(),
    satsReceived: bigint("sats_received", { mode: "number" }).notNull(),
    paymentHash: text("payment_hash").notNull(),
    preimage: text("preimage").notNull(),
    clientIdentifier: text("client_identifier").notNull(),
  },
  (table) => [
    uniqueIndex("revenue_ledger_payment_hash_uidx").on(table.paymentHash),
    index("revenue_ledger_timestamp_idx").on(table.timestamp),
    index("revenue_ledger_channel_idx").on(table.channel),
  ],
);

export type RevenueLedgerRow = typeof revenueLedgerTable.$inferSelect;
export type NewRevenueLedgerRow = typeof revenueLedgerTable.$inferInsert;
