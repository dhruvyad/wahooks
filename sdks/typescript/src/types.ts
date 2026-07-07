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
  name?: string | null;
  isGroup?: boolean;
  lastMessage?: { body: string | null; timestamp: number; fromMe: boolean } | null;
  unread?: boolean;
  conversationTimestamp?: number;
  [key: string]: unknown;
}

export interface MessageMedia {
  url: string;
  mimetype?: string;
  filename?: string;
  size?: number;
}

export interface Message {
  id: string;
  chatId: string;
  timestamp: number;
  fromMe: boolean;
  senderJid: string | null;
  senderPushName: string | null;
  type: string;
  text: string | null;
  quotedMessageId: string | null;
  media: MessageMedia | null;
  edited?: boolean;
  deleted?: boolean;
}

export interface MessagePage {
  messages: Message[];
  nextBefore: string | null;
  historyStartsAt: number | null;
}

export interface Contact {
  jid: string;
  name: string | null;
  phoneNumber: string | null;
  isGroup: boolean;
  groupSubject?: string;
  participantCount?: number;
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

export interface BillingStatus {
  subscription: {
    active: boolean;
    status: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    monthlyAmount: number;
    currency: string;
  };
  slots: {
    paid: number;
    used: number;
    available: number;
  };
}

export interface SlotUpdate {
  slots: number;
  status: 'upgraded' | 'downgraded' | 'unchanged';
  proratedAmount: number;
  currency: string;
}
