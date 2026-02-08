import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { webhookConfigs } from "./webhook-configs.js";

export const webhookEventLogs = pgTable("webhook_event_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookConfigId: uuid("webhook_config_id")
    .notNull()
    .references(() => webhookConfigs.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status", { enum: ["pending", "delivered", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
