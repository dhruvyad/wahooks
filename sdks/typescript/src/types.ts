export interface WAHooksOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface Connection {
  id: string;
  userId: string;
  workerId: string | null;
  sessionName: string;
  phoneNumber: string | null;
  status: string;
  engine: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfig {
  id: string;
  userId: string;
  sessionId: string;
  url: string;
  events: string[];
  signingSecret: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookLog {
  id: string;
  webhookConfigId: string;
  eventType: string;
  payload: unknown;
  status: string;
  attempts: number;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiTokenCreated extends ApiToken {
  token: string;
}

export interface Chat {
  id: string;
  name?: string;
  conversationTimestamp?: number;
  [key: string]: unknown;
}

export interface Profile {
  id: string;
  pushName: string;
  [key: string]: unknown;
}

export interface SendResult {
  id: string;
  timestamp: number;
}

export interface ScannableConnection {
  id: string;
  status: string;
  qr: string | null;
}
