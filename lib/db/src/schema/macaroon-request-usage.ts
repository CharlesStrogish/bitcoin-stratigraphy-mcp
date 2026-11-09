// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Existing shared quota counters, including prepaid scanner credits.
 * Keep this registered so schema synchronization preserves funded usage.
 */
export const macaroonRequestUsageTable = pgTable("macaroon_request_usage", {
  tokenId: text("token_id").primaryKey(),
  requestCount: bigint("request_count", { mode: "bigint" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const insertMacaroonRequestUsageSchema = createInsertSchema(
  macaroonRequestUsageTable,
);
export type InsertMacaroonRequestUsage = z.infer<
  typeof insertMacaroonRequestUsageSchema
>;
export type MacaroonRequestUsage = typeof macaroonRequestUsageTable.$inferSelect;
