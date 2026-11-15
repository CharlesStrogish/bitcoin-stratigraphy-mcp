import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { fiatMintOrdersTable } from "./fiat-mint-orders";

/** Application email delivery state only, never a duplicate Stripe payment catalog. */
export const stripeEnterpriseDeliveriesTable = pgTable(
  "stripe_enterprise_deliveries",
  {
    sessionId: text("session_id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => fiatMintOrdersTable.id),
    recipient: text("recipient").notNull(),
    eventId: text("event_id").notNull(),
    state: text("state").notNull().default("pending"),
    messageId: text("message_id"),
    sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);
export const insertStripeEnterpriseDeliverySchema = createInsertSchema(
  stripeEnterpriseDeliveriesTable,
);
export type StripeEnterpriseDelivery =
  typeof stripeEnterpriseDeliveriesTable.$inferSelect;
export type InsertStripeEnterpriseDelivery = z.infer<
  typeof insertStripeEnterpriseDeliverySchema
>;
