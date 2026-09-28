import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const stratigraphyProvenanceStrataTable = pgTable(
  "stratigraphy_provenance_strata",
  {
    day: integer("day").primaryKey(),
    stratumHash: text("stratum_hash").notNull().unique(),
    prevHash: text("prev_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);