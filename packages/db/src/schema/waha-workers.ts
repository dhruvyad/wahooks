import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

export const wahaWorkers = pgTable("waha_workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  podName: text("pod_name").unique(),
  internalIp: text("internal_ip"),
  apiKeyEnc: text("api_key_enc").notNull(), // encrypted WAHA API key
  status: text("status", {
    enum: ["provisioning", "active", "draining", "stopped"],
  })
    .notNull()
    .default("provisioning"),
  maxSessions: integer("max_sessions").notNull().default(50),
  currentSessions: integer("current_sessions").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
