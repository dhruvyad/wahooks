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

  async sendMessage(connectionId: string, chatId: string, text: string): Promise<SendResult> {
    return this.request('POST', `/connections/${connectionId}/send`, { chatId, text });
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
