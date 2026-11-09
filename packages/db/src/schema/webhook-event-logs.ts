import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { webhookConfigs } from "./webhook-configs.js";

/**
 * One row per delivery of one event to one webhook. The API keeps only the most
 * recent rows per webhook (WEBHOOK_LOG_KEEP in the API's retention service; the
 * dashboard and GET /webhooks/:id/logs show the last 100). A row is written when
 * the first delivery attempt ends, not when the event is queued.
 */
export const webhookEventLogs = pgTable(
  "webhook_event_logs",
  {
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
  },
  (t) => [
    // "Newest N for this webhook": the logs endpoint and the retention trim.
    index("webhook_event_logs_config_created_idx").on(
      t.webhookConfigId,
      t.createdAt.desc(),
    ),
  ],
);
