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
  (table) => [
    index("payment_challenges_expires_at_idx").on(table.expiresAt),
  ],
);

export const paymentRangeChallengesTable = pgTable(
  "payment_range_challenges",
  {
    callerKey: text("caller_key").notNull(),
    scope: text("scope").notNull(),
    invoice: text("invoice").notNull(),
    paymentHash: text("payment_hash").notNull(),
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