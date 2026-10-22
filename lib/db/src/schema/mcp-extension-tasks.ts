import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mcpExtensionTasksTable = pgTable("mcp_extension_tasks", {
  taskId: text("task_id").primaryKey(),
  revision: integer("revision").notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const insertMcpExtensionTaskSchema = createInsertSchema(
  mcpExtensionTasksTable,
);
export type InsertMcpExtensionTask = z.infer<
  typeof insertMcpExtensionTaskSchema
>;
export type McpExtensionTask = typeof mcpExtensionTasksTable.$inferSelect;
