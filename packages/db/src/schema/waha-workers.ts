import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

// What a worker row runs. 'waha': a pod of the WAHA StatefulSet (one shared API
// key, scaled by the K8s orchestrator). 'gateway': a wagw box (the WAHA-compatible
// Go gateway in gateway/), with its own key and many accounts per box.
export const WORKER_KINDS = ["waha", "gateway"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

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
  kind: text("kind", { enum: WORKER_KINDS }).notNull().default("waha"),
  maxSessions: integer("max_sessions").notNull().default(50),
  currentSessions: integer("current_sessions").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
