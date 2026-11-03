// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { sql } from "drizzle-orm";
import { check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const genesisGrantsTable = pgTable("genesis_grants", {
  pubkey: text("pubkey").primaryKey(),
  successfulCalls: integer("successful_calls").notNull().default(0),
  reservations: text("reservations").array().notNull().default(sql`'{}'::text[]`),
}, table => [
  check("genesis_grants_pubkey", sql`${table.pubkey} ~ '^[0-9a-f]{64}$'`),
  check("genesis_grants_capacity", sql`${table.successfulCalls} >= 0 AND
    ${table.successfulCalls} + cardinality(${table.reservations}) <= 10`),
]);
export const insertGenesisGrantSchema = createInsertSchema(genesisGrantsTable);
export type InsertGenesisGrant = z.infer<typeof insertGenesisGrantSchema>;
export type GenesisGrant = typeof genesisGrantsTable.$inferSelect;
