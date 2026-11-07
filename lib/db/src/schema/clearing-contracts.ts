// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { bigint, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Separate A2A namespace: never shares staking balances or core escrow rows. */
export const clearingContractsTable = pgTable("clearing_contracts", {
  escrowId: text("escrow_id").primaryKey(),
  requestDigest: varchar("request_digest", { length: 64 }).notNull().unique(),
  buyerPubkey: varchar("buyer_pubkey", { length: 64 }).notNull(),
  workerPubkey: varchar("worker_pubkey", { length: 64 }).notNull(),
  taskHash: varchar("task_hash", { length: 64 }).notNull(),
  amountSats: bigint("amount_sats", { mode: "bigint" }).notNull(),
  status: text("status").notNull().default("pending"),
  invoice: text("invoice"),
  paymentHash: varchar("payment_hash", { length: 64 }).unique(),
  provider: text("provider"),
  macaroon: text("macaroon"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  settlementReceipt: text("settlement_receipt"),
  proofDigest: varchar("proof_digest", { length: 64 }),
});

export const insertClearingContractSchema = createInsertSchema(
  clearingContractsTable,
);
export type ClearingContractRow = typeof clearingContractsTable.$inferSelect;
