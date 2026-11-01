import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { privateYieldClaimsTable } from "./private-yield-earnings";

/** Additional simulated allocation; existing 21% earnings are unchanged. */
export const swarmRoyaltiesTable = pgTable("private_swarm_royalties", {
  paymentHash: text("payment_hash").primaryKey(),
  owner: text("owner").notNull(),
  provider: text("provider").notNull(),
  grossMsats: bigint("gross_msats", { mode: "bigint" }).notNull(),
  earnedMsats: bigint("earned_msats", { mode: "bigint" }).notNull(),
  balanceMsats: bigint("balance_msats", { mode: "bigint" }).notNull(),
  claimId: text("claim_id").references(() => privateYieldClaimsTable.id),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, table => [
  index("private_swarm_royalties_owner_idx").on(table.owner, table.paymentHash),
  check("swarm_royalty_arithmetic", sql`${table.grossMsats} > 0 AND ${table.earnedMsats} = ${table.grossMsats} * 5 / 100 AND ${table.balanceMsats} >= 0`),
  check("swarm_royalty_consumption", sql`(${table.claimId} IS NULL AND ${table.claimedAt} IS NULL AND ${table.balanceMsats} = ${table.earnedMsats}) OR (${table.claimId} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.balanceMsats} = 0)`),
]);
