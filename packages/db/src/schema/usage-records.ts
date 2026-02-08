import {
  pgTable,
  uuid,
  timestamp,
  numeric,
  boolean,
} from "drizzle-orm/pg-core";
import { wahaSessions } from "./waha-sessions.js";

export const usageRecords = pgTable("usage_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => wahaSessions.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(), // hourly bucket start
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(), // hourly bucket end
  connectionHours: numeric("connection_hours", {
    precision: 10,
    scale: 6,
  }).notNull(), // fractional hours active in this period
  reportedToStripe: boolean("reported_to_stripe").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
