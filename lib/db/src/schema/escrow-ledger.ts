import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
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

// Append-only, one row per settlement, written in the same transaction as the
// snapshot. agent_id is the sub-agent named by the paid credential's verified
// `agent_id` caveat and committed into the receipt's Merkle leaf. The column is
// nullable with no other default, so it is NULL when no caveat was present.
// is_authenticated is true only for a NIP-98 bound agent_id (a Nostr pubkey):
// the server verified that key's Schnorr signature over the paid settlement
// request itself. Self-declared and unattributed settlements are false.
export const escrowLedgerSettlementsTable = pgTable(
  "escrow_ledger_settlements",
  {
    ledgerId: text("ledger_id")
      .notNull()
      .references(() => escrowLedgerTable.id),
    escrowId: text("escrow_id").notNull(),
    agentId: varchar("agent_id", { length: 128 }),
    isAuthenticated: boolean("is_authenticated").notNull().default(false),
    leafIndex: integer("leaf_index").notNull(),
    executionLeafHash: text("execution_leaf_hash").notNull(),
    merkleRoot: text("merkle_root").notNull(),
    settledAtStrataBlock: bigint("settled_at_strata_block", { mode: "number" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    paymentHash: text("payment_hash"),
    tollSats: bigint("toll_sats", { mode: "number" }),
    settlementProvider: text("settlement_provider"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ledgerId, table.escrowId] }),
    uniqueIndex("escrow_ledger_settlements_leaf_uidx").on(table.ledgerId, table.leafIndex),
    index("escrow_ledger_settlements_agent_id_idx").on(table.agentId),
  ],
);
export type EscrowLedgerSettlementRow = typeof escrowLedgerSettlementsTable.$inferSelect;
