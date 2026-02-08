// Worker statuses
export type WorkerStatus = "provisioning" | "active" | "draining" | "stopped";

// Session statuses
export type SessionStatus =
  | "pending"
  | "scan_qr"
  | "working"
  | "failed"
  | "stopped";

// Webhook event delivery statuses
export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

// WAHA engine types
export type WahaEngine = "NOWEB" | "WEBJS" | "GOWS";

// WAHA webhook event types we handle
export type WahaEventType =
  | "message"
  | "message.any"
  | "message.ack"
  | "message.reaction"
  | "message.revoked"
  | "state.change"
  | "group.join"
  | "group.leave"
  | "session.status";

// API response wrapper
export interface ApiResponse<T> {
  data: T;
  error?: string;
}

// Paginated response
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Worker info (client-facing, no secrets)
export interface WorkerInfo {
  id: string;
  status: WorkerStatus;
  maxSessions: number;
  currentSessions: number;
}

// Session info (client-facing)
export interface SessionInfo {
  id: string;
  sessionName: string;
  phoneNumber: string | null;
  status: SessionStatus;
  engine: WahaEngine;
  createdAt: string;
  updatedAt: string;
}

// Webhook config (client-facing)
export interface WebhookConfig {
  id: string;
  sessionId: string;
  url: string;
  events: WahaEventType[];
  active: boolean;
  createdAt: string;
}

// Webhook event log entry (client-facing)
export interface WebhookEventLog {
  id: string;
  webhookConfigId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  deliveredAt: string | null;
  createdAt: string;
}

// Billing constants
export const BILLING = {
  PRICE_PER_CONNECTION_MONTH: 0.25,
  HOURS_PER_MONTH: 720, // 30 * 24
  PRICE_PER_CONNECTION_HOUR: 0.25 / 720, // ~$0.000347
} as const;

// Usage record for billing
export interface UsageRecord {
  id: string;
  sessionId: string;
  periodStart: string; // ISO timestamp, hourly bucket
  periodEnd: string;
  connectionHours: number;
  reportedToStripe: boolean;
  createdAt: string;
}

// Create connection request
export interface CreateConnectionRequest {
  name?: string;
}

// Create webhook config request
export interface CreateWebhookConfigRequest {
  sessionId: string;
  url: string;
  events: WahaEventType[];
}
