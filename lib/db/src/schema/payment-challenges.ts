import {
  bigint,
  jsonb,
  index,
  primaryKey,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const paymentChallengesTable = pgTable(
  "payment_challenges",
  {
    callerKey: text("caller_key").primaryKey(),
    invoice: text("invoice"),
    paymentHash: text("payment_hash"),
    challengeScope: text("challenge_scope"),
    challengeExpiresAt: timestamp("challenge_expires_at", {
      withTimezone: true,
    }),
    invoiceAttemptedAt: jsonb("invoice_attempted_at")
      .$type<number[]>()
      .notNull()
      .default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("payment_challenges_expires_at_idx").on(table.expiresAt)],
);

export const paymentRangeChallengesTable = pgTable(
  "payment_range_challenges",
  {
    callerKey: text("caller_key").notNull(),
    scope: text("scope").notNull(),
    invoice: text("invoice").notNull(),
    paymentHash: text("payment_hash").notNull(),
    provider: text("provider").notNull().default("legacy-unbound"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.callerKey, table.scope] }),
    index("payment_range_challenges_expires_at_idx").on(table.expiresAt),
  ],
);

export const paymentInvoiceBindingsTable = pgTable(
  "payment_invoice_bindings",
  {
    callerKey: text("caller_key").notNull(),
    paymentHash: text("payment_hash").notNull(),
    provider: text("provider").notNull(),
    asset: text("asset").notNull(),
    redeemUntil: timestamp("redeem_until", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.callerKey, table.paymentHash] }),
    index("payment_invoice_bindings_redeem_until_idx").on(table.redeemUntil),
  ],
);
