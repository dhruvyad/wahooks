export interface WahaSessionResponse {
  name: string;
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED';
  config?: {
    webhooks?: Array<{
      url: string;
      events: string[];
      customHeaders?: Array<{ name: string; value: string }>;
    }>;
    [key: string]: unknown;
  };
  /** The linked account; null (gateway) or absent when the session holds no linked device. */
  me?: {
    id: string;
    pushName: string;
  } | null;
}

export interface WahaQrCodeResponse {
  value: string;
  mimetype: string;
}

export interface WahaChatResponse {
  id: string;
  name?: string;
  timestamp: number;
  lastMessage?: { body: string; timestamp: number; fromMe: boolean };
}

export interface WahaMeResponse {
  id: string;
  pushName: string;
}

export interface WahaSendTextResponse {
  id: string;
  timestamp: number;
}

/** A group member in WAHA NOWEB's group metadata (Baileys GroupParticipant). Ids are `@s.whatsapp.net` or `@lid`. */
export interface WahaGroupMember {
  id: string;
  phoneNumber?: string;
  lid?: string;
  admin?: 'admin' | 'superadmin' | null;
  /** The account's contact name for them (gateway). */
  name?: string;
  /** Their WhatsApp push name (gateway). */
  notify?: string;
  /** Set on a member WhatsApp didn't add when the group was created (gateway): 403, 404, 408, … */
  error?: number;
  addRequest?: { code: string; expiration: number | null };
  /** True on the connection's own entry (gateway). */
  isMe?: boolean;
}

/** WAHA NOWEB's group metadata (Baileys GroupMetadata): times in seconds. */
export interface WahaGroupMetadata {
  id: string;
  subject?: string;
  desc?: string;
  owner?: string;
  ownerPn?: string;
  creation?: number;
  size?: number;
  restrict?: boolean;
  announce?: boolean;
  isCommunity?: boolean;
  participants?: WahaGroupMember[];
  [key: string]: unknown;
}

/** One entry of a participants add/remove answer: status "200" or WhatsApp's error code. */
export interface WahaGroupParticipantResult {
  status: string;
  jid: string;
  phoneNumber?: string;
  lid?: string;
  addRequest?: { code: string; expiration: number | null };
}
