import {
  bigint,
  jsonb,
  index,
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