import {
  customType,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const otsProvenanceAnchorsTable = pgTable("ots_provenance_anchors", {
  headHash: text("head_hash").primaryKey(),
  merkleRoot: text("merkle_root").notNull(),
  totalDepth: integer("total_depth").notNull(),
  otsProof: bytea("ots_proof").notNull(),
  otsStatus: text("ots_status")
    .$type<"pending_calendar" | "bitcoin_block_attested">()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
