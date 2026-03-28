import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WahaSessionResponse,
  WahaQrCodeResponse,
  WahaChatResponse,
  WahaMeResponse,
  WahaSendTextResponse,
} from './waha.types';

@Injectable()
export class WahaService {
  private readonly logger = new Logger(WahaService.name);
  private readonly maxSessions: number;

  constructor(private readonly configService: ConfigService) {
    this.maxSessions = Number(
      this.configService.get('WAHA_MAX_SESSIONS', '1'),
    );
  }

  /**
   * Resolve the WAHA session name. WAHA Core only supports 'default'.
   * WAHA Plus supports custom session names.
   */
  resolveSessionName(dbSessionName: string): string {
    return this.maxSessions === 1 ? 'default' : dbSessionName;
  }

  /**
   * Fully reset a WAHA session: stop → logout → delete → recreate with config.
   * This ensures webhook URL and NOWEB store config are always preserved.
   */
  async resetSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    webhookUrl: string,
  ): Promise<void> {
    this.logger.log(
      `Resetting session "${sessionName}" on worker ${workerUrl}`,
    );
    try {
      await this.stopSession(workerUrl, apiKey, sessionName);
    } catch {
      // Ignore — may already be stopped
    }
    try {
      await this.logoutSession(workerUrl, apiKey, sessionName);
    } catch {
      // Ignore — clears auth state
    }
    try {
      await this.deleteSession(workerUrl, apiKey, sessionName);
    } catch {
      // Ignore — may not exist
    }
    await this.createSession(workerUrl, apiKey, sessionName, webhookUrl);
    await this.startSession(workerUrl, apiKey, sessionName);
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  private buildUrl(workerUrl: string, path: string): string {
    return `http://${workerUrl}:3000${path}`;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const responseBody = await response.text();
        const message = `WAHA API error: ${method} ${url} returned ${response.status} - ${responseBody}`;
        this.logger.error(message);
        throw new Error(message);
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const message = `WAHA API timeout: ${method} ${url} exceeded 30s`;
        this.logger.error(message);
        throw new Error(message);
      }

      if (error instanceof Error && error.message.startsWith('WAHA API')) {
        throw error;
      }

      this.logger.error(
        `WAHA API request failed: ${method} ${url} - ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    webhookUrl?: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(workerUrl, '/api/sessions');
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Creating session "${sessionName}" on worker ${workerUrl}`);

    return this.request<WahaSessionResponse>('POST', url, headers, {
      name: sessionName,
      config: {
        noweb: {
          store: {
            enabled: true,
            fullSync: true,
          },
        },
        webhooks: webhookUrl
          ? [
              {
                url: webhookUrl,
                events: ['*'],
              },
            ]
          : [],
      },
    });
  }

  async startSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/start`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Starting session "${sessionName}" on worker ${workerUrl}`);

    await this.request<void>('POST', url, headers);
  }

  async stopSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/stop`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Stopping session "${sessionName}" on worker ${workerUrl}`);

    await this.request<void>('POST', url, headers);
  }

  async deleteSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Deleting session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('DELETE', url, headers);
  }

  async getSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Getting session "${sessionName}" from worker ${workerUrl}`,
    );

    return this.request<WahaSessionResponse>('GET', url, headers);
  }

  async listSessions(
    workerUrl: string,
    apiKey: string,
  ): Promise<WahaSessionResponse[]> {
    const url = this.buildUrl(workerUrl, '/api/sessions?all=true');
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Listing sessions on worker ${workerUrl}`);

    return this.request<WahaSessionResponse[]>('GET', url, headers);
  }

  async getQrCode(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaQrCodeResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/auth/qr`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Getting QR code for session "${sessionName}" on worker ${workerUrl}`,
    );

    // QR endpoint returns raw PNG by default, not JSON
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        const message = `WAHA API error: GET ${url} returned ${response.status} - ${body}`;
        this.logger.error(message);
        throw new Error(message);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      return {
        value: base64,
        mimetype: response.headers.get('content-type') || 'image/png',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async restartSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/restart`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Restarting session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('POST', url, headers);
  }

  async getChats(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaChatResponse[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats?limit=20&sortBy=conversationTimestamp&sortOrder=desc`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<WahaChatResponse[]>('GET', url, headers);
  }

  async getProfilePicture(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    contactId: string,
  ): Promise<{ profilePictureUrl: string | null }> {
    const url = this.buildUrl(
      workerUrl,
      `/api/contacts/profile-picture?contactId=${encodeURIComponent(contactId)}&session=${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    try {
      const result = await this.request<{ profilePictureURL: string | null }>('GET', url, headers);
      return { profilePictureUrl: result.profilePictureURL };
    } catch {
      return { profilePictureUrl: null };
    }
  }

  private buildFilePayload(opts: { mediaUrl?: string; mediaData?: string; mimetype?: string; filename?: string }): any {
    if (opts.mediaData) {
      const file: any = { data: opts.mediaData };
      if (opts.mimetype) file.mimetype = opts.mimetype;
      if (opts.filename) file.filename = opts.filename;
      return file;
    }
    const file: any = { url: opts.mediaUrl };
    if (opts.filename) file.filename = opts.filename;
    return file;
  }

  async sendImage(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    caption?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId);
    }
    const url = this.buildUrl(workerUrl, '/api/sendImage');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, session: sessionName, file: this.buildFilePayload({ mediaUrl, mediaData, mimetype }) };
    if (caption) body.caption = caption;

    return this.request<any>('POST', url, headers, body);
  }

  async sendFile(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    filename?: string,
    caption?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId);
    }
    const url = this.buildUrl(workerUrl, '/api/sendFile');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, session: sessionName, file: this.buildFilePayload({ mediaUrl, mediaData, mimetype, filename }) };
    if (caption) body.caption = caption;

    return this.request<any>('POST', url, headers, body);
  }

  async sendVoice(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId);
    }
    const url = this.buildUrl(workerUrl, '/api/sendVoice');
    const headers = this.buildHeaders(apiKey);

    return this.request<any>('POST', url, headers, {
      chatId,
      session: sessionName,
      file: this.buildFilePayload({ mediaUrl, mediaData, mimetype }),
    });
  }

  async sendVideo(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    mediaUrl?: string,
    caption?: string,
    mediaData?: string,
    mimetype?: string,
    options?: { skipPresence?: boolean },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId);
    }
    const url = this.buildUrl(workerUrl, '/api/sendVideo');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, session: sessionName, file: this.buildFilePayload({ mediaUrl, mediaData, mimetype }) };
    if (caption) body.caption = caption;

    return this.request<any>('POST', url, headers, body);
  }

  async sendLocation(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    options?: { skipPresence?: boolean },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId);
    }
    const url = this.buildUrl(workerUrl, '/api/sendLocation');
    const headers = this.buildHeaders(apiKey);

    return this.request<any>('POST', url, headers, {
      chatId,
      session: sessionName,
      latitude,
      longitude,
      title: name,
      address,
    });
  }

  async sendContactVcard(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    contactName: string,
    contactPhone: string,
    options?: { skipPresence?: boolean },
  ): Promise<any> {
    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId);
    }
    const url = this.buildUrl(workerUrl, '/api/sendContactVcard');
    const headers = this.buildHeaders(apiKey);
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${contactName}`,
      `TEL;type=CELL;type=VOICE;waid=${contactPhone.replace(/\D/g, '')}:+${contactPhone.replace(/\D/g, '')}`,
      'END:VCARD',
    ].join('\n');

    return this.request<any>('POST', url, headers, {
      chatId,
      session: sessionName,
      contacts: [{ vcard }],
    });
  }

  async getMessages(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    limit: number = 50,
  ): Promise<any[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&downloadMedia=false`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<any[]>('GET', url, headers);
  }

  async getMe(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaMeResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/me`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<WahaMeResponse>('GET', url, headers);
  }

  async sendSeen(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/sendSeen');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('POST', url, headers, {
      chatId,
      session: sessionName,
    });
  }

  async startTyping(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/startTyping');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('POST', url, headers, {
      chatId,
      session: sessionName,
    });
  }

  async stopTyping(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/stopTyping');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('POST', url, headers, {
      chatId,
      session: sessionName,
    });
  }

  /**
   * Send text with anti-spam behavior:
   * 1. Mark chat as seen
   * 2. Start typing indicator
   * 3. Wait a random delay based on message length (simulates human typing)
   * 4. Stop typing
   * 5. Send the message
   */
  /**
   * Human-like presence: seen → typing → random delay → stop typing.
   * Used before any send to comply with WhatsApp anti-ban guidelines.
   */
  async simulatePresence(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    contentLength = 20,
  ): Promise<void> {
    try { await this.sendSeen(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }
    try { await this.startTyping(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }

    const baseDelay = 1000 + Math.random() * 2000;
    const typingDelay = Math.min(contentLength * 50, 5000);
    await new Promise((resolve) => setTimeout(resolve, baseDelay + typingDelay));

    try { await this.stopTyping(workerUrl, apiKey, sessionName, chatId); } catch { /* non-critical */ }
  }

  async sendText(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    text: string,
    options?: { skipPresence?: boolean; replyTo?: string },
  ): Promise<WahaSendTextResponse> {
    this.logger.log(
      `Sending text to ${chatId} via session "${sessionName}" on worker ${workerUrl}`,
    );

    if (!options?.skipPresence) {
      await this.simulatePresence(workerUrl, apiKey, sessionName, chatId, text.length);
    }

    const url = this.buildUrl(workerUrl, '/api/sendText');
    const headers = this.buildHeaders(apiKey);
    const body: any = { chatId, text, session: sessionName };
    if (options?.replyTo) body.reply_to = options.replyTo;

    return this.request<WahaSendTextResponse>('POST', url, headers, body);
  }

  async sendReaction(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    const url = this.buildUrl(workerUrl, '/api/reaction');
    const headers = this.buildHeaders(apiKey);

    await this.request<void>('PUT', url, headers, {
      chatId,
      messageId,
      reaction,
      session: sessionName,
    });
  }

  async logoutSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/logout`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Logging out session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('POST', url, headers);
  }
}
