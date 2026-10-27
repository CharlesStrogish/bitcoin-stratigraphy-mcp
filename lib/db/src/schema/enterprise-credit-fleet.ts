import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { enterpriseCreditAccountsTable } from "./enterprise-credit-accounts";

// One billing owner per Worker makes routing an indexed point lookup.
export const enterpriseCreditFleetTable = pgTable(
  "enterprise_credit_fleet",
  {
    workerPubkey: text("worker_pubkey").primaryKey(),
    commanderPubkey: text("commander_pubkey")
      .notNull()
      .references(() => enterpriseCreditAccountsTable.pubkey),
    maxSpendLimit: bigint("max_spend_limit", { mode: "number" }),
    spentSats: bigint("spent_sats", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("enterprise_credit_fleet_commander_idx").on(table.commanderPubkey),
    check(
      "enterprise_credit_fleet_spend_check",
      sql`${table.spentSats} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "enterprise_credit_fleet_limit_check",
      sql`${table.maxSpendLimit} IS NULL OR ${table.maxSpendLimit} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      "enterprise_credit_fleet_not_self",
      sql`${table.workerPubkey} <> ${table.commanderPubkey}`,
    ),
    check(
      "enterprise_credit_fleet_worker_key",
      sql`${table.workerPubkey} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

// Persist consumed administrative signatures so a replay cannot re-add a
// revoked Worker (including across processes and restarts).
export const enterpriseCreditFleetUpdatesTable = pgTable(
  "enterprise_credit_fleet_updates",
  {
    eventId: text("event_id").primaryKey(),
    commanderPubkey: text("commander_pubkey")
      .notNull()
      .references(() => enterpriseCreditAccountsTable.pubkey),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const insertEnterpriseCreditFleetSchema = createInsertSchema(
  enterpriseCreditFleetTable,
);
export type InsertEnterpriseCreditFleet = z.infer<
  typeof insertEnterpriseCreditFleetSchema
>;
export type EnterpriseCreditFleet =
  typeof enterpriseCreditFleetTable.$inferSelect;
export const insertEnterpriseCreditFleetUpdateSchema = createInsertSchema(
  enterpriseCreditFleetUpdatesTable,
);
export type InsertEnterpriseCreditFleetUpdate = z.infer<
  typeof insertEnterpriseCreditFleetUpdateSchema
>;
export type EnterpriseCreditFleetUpdate =
  typeof enterpriseCreditFleetUpdatesTable.$inferSelect;
