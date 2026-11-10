import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { wahaSessions } from "./waha-sessions.js";

export const webhookConfigs = pgTable("webhook_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => wahaSessions.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  events: text("events").array().notNull(), // e.g. ["message", "session.status"]
  signingSecret: text("signing_secret").notNull(), // HMAC-SHA256 key
  active: boolean("active").notNull().default(true),
  // Start of the current run of deliveries that failed every retry; cleared by any success.
  failingSince: timestamp("failing_since", { withTimezone: true }),
  // Set with active=false when WAHooks paused the webhook itself ('failing': nothing but failures for
  // days); null when its owner switched it off. Resuming clears both.
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pausedReason: text("paused_reason", { enum: ["failing"] }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
