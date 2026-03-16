import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { wahaWorkers } from "./waha-workers.js";

export const wahaSessions = pgTable("waha_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workerId: uuid("worker_id").references(() => wahaWorkers.id, {
    onDelete: "set null",
  }),
  name: text("name"), // user-friendly display name
  sessionName: text("session_name").notNull().unique(), // format: u_{userId}_s_{sessionId}
  phoneNumber: text("phone_number"),
  status: text("status", {
    enum: ["pending", "scan_qr", "working", "failed", "stopped"],
  })
    .notNull()
    .default("pending"),
  engine: text("engine", { enum: ["NOWEB", "WEBJS", "GOWS"] })
    .notNull()
    .default("NOWEB"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
