import type {
  WAHooksOptions,
  Connection,
  ScannableConnection,
  WebhookConfig,
  WebhookLog,
  ApiToken,
  ApiTokenCreated,
  Chat,
  Profile,
  SendResult,
} from './types';

const DEFAULT_BASE_URL = 'https://api.wahooks.com';

export interface WAHooksEvent {
  event: string;
  connectionId: string;
  payload: unknown;
  timestamp: string;
}

/**
 * Real-time event stream over WebSocket. Auto-reconnects on disconnect.
 */
export class WAHooksEventStream {
  onmessage?: (event: WAHooksEvent) => void;
  onerror?: (error: Error) => void;
  onopen?: () => void;
  onclose?: () => void;

  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly url: string) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.onopen?.();
    };

    this.ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString()) as WAHooksEvent;
        this.onmessage?.(data);
      } catch (e) {
        this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      }
    };

    this.ws.onerror = (e) => {
      this.onerror?.(new Error('WebSocket error'));
    };

    this.ws.onclose = () => {
      this.onclose?.();
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    };
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

class WAHooksError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'WAHooksError';
  }
}

export class WAHooks {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: WAHooksOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = (data as any)?.message || response.statusText;
      throw new WAHooksError(message, response.status, data);
    }

    return data as T;
  }

  // --- Connections ---

  async listConnections(): Promise<Connection[]> {
    return this.request('GET', '/connections');
  }

  async createConnection(): Promise<Connection> {
    return this.request('POST', '/connections');
  }

  /**
   * Get a connection ready to scan. Reuses an idle one if available, or creates new.
   * Returns { id, status, qr } — one call instead of list + filter + restart/create.
   */
  async getOrCreateScannableConnection(): Promise<ScannableConnection> {
    return this.request('POST', '/connections/get-or-create');
  }

  async getConnection(id: string): Promise<Connection> {
    return this.request('GET', `/connections/${id}`);
  }

  async deleteConnection(id: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/connections/${id}`);
  }

  async restartConnection(id: string): Promise<Connection> {
    return this.request('POST', `/connections/${id}/restart`);
  }

  async getQR(connectionId: string): Promise<{ value: string }> {
    return this.request('GET', `/connections/${connectionId}/qr`);
  }

  async getChats(connectionId: string): Promise<Chat[]> {
    return this.request('GET', `/connections/${connectionId}/chats`);
  }

  async getProfile(connectionId: string): Promise<Profile> {
    return this.request('GET', `/connections/${connectionId}/me`);
  }

  async sendMessage(connectionId: string, chatId: string, text: string, options?: { skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send`, { chatId, text, ...options });
  }

  async markRead(connectionId: string, chatId: string): Promise<{ success: boolean }> {
    return this.request('POST', `/connections/${connectionId}/mark-read`, { chatId });
  }

  async startTyping(connectionId: string, chatId: string): Promise<{ success: boolean }> {
    return this.request('POST', `/connections/${connectionId}/typing`, { chatId });
  }

  async stopTyping(connectionId: string, chatId: string): Promise<{ success: boolean }> {
    return this.request('POST', `/connections/${connectionId}/typing/stop`, { chatId });
  }

  /** Send an image. Provide `url` (public URL) or `data` (base64) + `mimetype`. */
  async sendImage(connectionId: string, chatId: string, options: { url?: string; data?: string; mimetype?: string; caption?: string; skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send-image`, { chatId, ...options });
  }

  /** Send a document/file. Provide `url` or `data` + `mimetype`. */
  async sendDocument(connectionId: string, chatId: string, options: { url?: string; data?: string; mimetype?: string; filename?: string; caption?: string; skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send-document`, { chatId, ...options });
  }

  /** Send a video. Provide `url` or `data` + `mimetype`. */
  async sendVideo(connectionId: string, chatId: string, options: { url?: string; data?: string; mimetype?: string; caption?: string; skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send-video`, { chatId, ...options });
  }

  /** Send audio/voice. Provide `url` or `data` + `mimetype`. */
  async sendAudio(connectionId: string, chatId: string, options: { url?: string; data?: string; mimetype?: string; skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send-audio`, { chatId, ...options });
  }

  async sendLocation(connectionId: string, chatId: string, latitude: number, longitude: number, name?: string, address?: string, options?: { skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send-location`, { chatId, latitude, longitude, name, address, ...options });
  }

  async sendContact(connectionId: string, chatId: string, contactName: string, contactPhone: string, options?: { skipPresence?: boolean }): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send-contact`, { chatId, contactName, contactPhone, ...options });
  }

  // --- Real-time Events ---

  /**
   * Connect to the real-time event stream via WebSocket.
   * Returns an EventSource-like object with onmessage/onerror/close.
   *
   * ```ts
   * const stream = client.listen();
   * stream.onmessage = (event) => {
   *   console.log(event.event, event.connectionId, event.payload);
   * };
   * // later: stream.close();
   * ```
   */
  listen(): WAHooksEventStream {
    const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const wsHost = this.baseUrl.replace(/^https?/, wsProtocol);
    const wsUrl = `${wsHost}/api/ws?token=${encodeURIComponent(this.apiKey)}`;
    return new WAHooksEventStream(wsUrl);
  }

  // --- Webhooks ---

  async listWebhooks(connectionId: string): Promise<WebhookConfig[]> {
    return this.request('GET', `/connections/${connectionId}/webhooks`);
  }

  async createWebhook(connectionId: string, url: string, events: string[] = ['*']): Promise<WebhookConfig> {
    return this.request('POST', `/connections/${connectionId}/webhooks`, { url, events });
  }

  async updateWebhook(webhookId: string, updates: { url?: string; events?: string[]; active?: boolean }): Promise<WebhookConfig> {
    return this.request('PUT', `/webhooks/${webhookId}`, updates);
  }

  async deleteWebhook(webhookId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/webhooks/${webhookId}`);
  }

  async getWebhookLogs(webhookId: string): Promise<WebhookLog[]> {
    return this.request('GET', `/webhooks/${webhookId}/logs`);
  }

  async testWebhook(webhookId: string): Promise<{ success: boolean; logId: string }> {
    return this.request('POST', `/webhooks/${webhookId}/test`);
  }

  // --- API Tokens ---

  async listTokens(): Promise<ApiToken[]> {
    return this.request('GET', '/tokens');
  }

  async createToken(name: string): Promise<ApiTokenCreated> {
    return this.request('POST', '/tokens', { name });
  }

  async revokeToken(tokenId: string): Promise<{ success: boolean }> {
    return this.request('DELETE', `/tokens/${tokenId}`);
  }
}
