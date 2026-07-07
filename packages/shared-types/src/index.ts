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

// --- Message history / contacts (read APIs) ---

// Media metadata attached to a message. `url` is the WAHooks media-proxy URL
// (authenticated, same Bearer token as other endpoints), not the internal WAHA URL.
export interface MessageMedia {
  url: string;
  mimetype?: string;
  filename?: string;
  size?: number;
}

// Canonical message shape returned by the history read endpoints. This is the
// single schema WAHooks normalizes WAHA's raw payload into; a future webhook
// change should converge on it too.
export interface Message {
  id: string;
  chatId: string;
  timestamp: number; // WhatsApp message timestamp (unix seconds)
  fromMe: boolean;
  senderJid: string | null; // who sent it — crucial for groups
  senderPushName: string | null;
  type: string; // "text" | "image" | "video" | "audio" | "document" | "location" | "contact" | ...
  text: string | null; // body or caption
  quotedMessageId: string | null;
  media: MessageMedia | null;
  edited?: boolean;
  deleted?: boolean; // tombstone if the message was revoked
}

// A page of messages, newest-first. `nextBefore` is an opaque cursor for the
// next (older) page, or null when history is exhausted. `historyStartsAt`
// lets consumers distinguish "no messages" from "history doesn't reach further".
export interface MessagePage {
  messages: Message[];
  nextBefore: string | null;
  historyStartsAt: number | null;
}

// A WhatsApp contact (person). Groups are surfaced via chats, not contacts.
export interface Contact {
  jid: string;
  name: string | null;
  phoneNumber: string | null;
  isGroup: boolean;
  groupSubject?: string;
  participantCount?: number;
}

// Enriched chat summary returned by GET /connections/:id/chats.
export interface ChatSummary {
  id: string;
  name: string | null;
  isGroup: boolean;
  lastMessage: {
    body: string | null;
    timestamp: number;
    fromMe: boolean;
  } | null;
  unread: boolean;
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
