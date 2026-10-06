import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const revokedMacaroonsTable = pgTable("revoked_macaroons", {
  signatureId: text("signature_id").primaryKey(),
  revokedAt: timestamp("revoked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  reason: text("reason"),
});
