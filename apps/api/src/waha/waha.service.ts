import { HttpException, Injectable, Logger } from '@nestjs/common';
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

  // Cache of resolved send targets (phone digits → canonical WAHA chatId) so we
  // don't hit WAHA's check-exists on every send. Keyed by `${sessionName}:${digits}`
  // and TTL'd, because a contact's canonical identity can shift over time (e.g.
  // WhatsApp LID migration).
  private readonly chatIdCache = new Map<string, { chatId: string; exp: number }>();
  private readonly CHATID_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
  private readonly CHATID_CACHE_MAX = 10_000;

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
        this.logger.error(
          `WAHA API error: ${method} ${url} returned ${response.status} - ${responseBody}`,
        );
        // Surface a concise, actionable error to API callers instead of a
        // generic 500: WAHA 4xx (bad request contents) → 400, WAHA 5xx → 502.
        // Message keeps the 'WAHA API error' prefix — internal callers match on it.
        const detail = this.extractWahaErrorDetail(responseBody);
        const message = `WAHA API error: ${method} ${url} returned ${response.status} - ${detail}`;
        throw new HttpException(message, response.status >= 500 ? 502 : 400);
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

  /**
   * Pull the human-meaningful message out of a WAHA error body (which can be a
   * huge JSON envelope with stack traces and the full request echoed back).
   */
  private extractWahaErrorDetail(body: string): string {
    try {
      const parsed = JSON.parse(body);
      const detail =
        parsed?.exception?.message ?? parsed?.message ?? parsed?.error;
      if (typeof detail === 'string' && detail) return detail;
      if (Array.isArray(detail) && detail.length) return detail.join('; ');
    } catch {
      // not JSON — fall through to truncation
    }
    return body.length > 300 ? `${body.slice(0, 300)}…` : body;
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
    limit = 20,
  ): Promise<WahaChatResponse[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats?limit=${limit}&sortBy=conversationTimestamp&sortOrder=desc`,
    );
    const headers = this.buildHeaders(apiKey);

    return this.request<WahaChatResponse[]>('GET', url, headers);
  }

  /**
   * Chats with name, picture, and last-message preview in a single call.
   * Backs the enriched GET /connections/:id/chats endpoint.
   */
  async getChatsOverview(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    limit = 50,
    offset = 0,
  ): Promise<any[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats/overview?limit=${limit}&offset=${offset}`,
    );
    return this.request<any[]>('GET', url, this.buildHeaders(apiKey));
  }

  /**
   * List all contacts (people) known to the session.
   */
  async getContacts(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    limit = 500,
    offset = 0,
  ): Promise<any[]> {
    const url = this.buildUrl(
      workerUrl,
      `/api/contacts/all?session=${encodeURIComponent(sessionName)}&limit=${limit}&offset=${offset}`,
    );
    return this.request<any[]>('GET', url, this.buildHeaders(apiKey));
  }

  /**
   * Edit the text of a previously-sent message. WhatsApp only allows editing your
   * own messages within ~15 minutes; WAHA returns an error otherwise.
   */
  async editMessage(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    messageId: string,
    text: string,
  ): Promise<any> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    );
    return this.request<any>('PUT', url, this.buildHeaders(apiKey), { text });
  }

  /**
   * Fetch a single message by id. WAHA keys messages under a chat, so chatId is required.
   */
  async getMessage(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
    messageId: string,
  ): Promise<any> {
    const url = this.buildUrl(
      workerUrl,
      // downloadMedia=true — getMessageMedia depends on this response carrying
      // hasMedia + media.url; with false it always 404'd "Message has no media".
      `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`,
    );
    return this.request<any>('GET', url, this.buildHeaders(apiKey));
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
    let { mediaUrl, mediaData, mimetype } = opts;

    // WAHA downloads file.url with axios, which rejects data: URLs ("Invalid
    // URL" → 500). Clients (agents inlining local files) legitimately send
    // them, so decode data: URLs ourselves into WAHA's supported base64 form.
    if (!mediaData && mediaUrl?.startsWith('data:')) {
      const parsed = this.parseDataUrl(mediaUrl);
      if (parsed) {
        mediaData = parsed.data;
        mimetype = mimetype ?? parsed.mimetype;
        mediaUrl = undefined;
      }
    }

    if (mediaData) {
      const file: any = { data: mediaData };
      if (mimetype) file.mimetype = mimetype;
      if (opts.filename) file.filename = opts.filename;
      return file;
    }
    const file: any = { url: mediaUrl };
    if (opts.filename) file.filename = opts.filename;
    return file;
  }

  /**
   * Parse a data: URL into { mimetype, data(base64) }. Handles both base64
   * payloads (`data:image/png;base64,...`) and percent-encoded text payloads
   * (`data:image/svg+xml;charset=utf-8,%3Csvg...`). Returns null if malformed.
   */
  private parseDataUrl(url: string): { mimetype?: string; data: string } | null {
    const m = url.match(/^data:([^;,]+)?((?:;[^;,=]+=[^;,]*)*)(;base64)?,([\s\S]*)$/);
    if (!m) return null;
    const mimetype = m[1] || undefined;
    const raw = m[4];
    try {
      if (m[3]) {
        // base64 payload — tolerate percent-encoding and whitespace
        const b64 = (raw.includes('%') ? decodeURIComponent(raw) : raw).replace(/\s/g, '');
        return { mimetype, data: b64 };
      }
      // text payload — percent-decode, then base64-encode for WAHA
      return {
        mimetype,
        data: Buffer.from(decodeURIComponent(raw), 'utf8').toString('base64'),
      };
    } catch {
      return null;
    }
  }

  /**
   * Ask WAHA whether a phone number is on WhatsApp and, if so, its canonical
   * chatId. WAHA normalizes here (e.g. Brazilian "9th digit", LID-migrated
   * contacts), so the returned chatId is the form that actually routes.
   */
  async checkNumberExists(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    phone: string,
  ): Promise<{ numberExists: boolean; chatId?: string } | null> {
    const url = this.buildUrl(
      workerUrl,
      `/api/contacts/check-exists?phone=${encodeURIComponent(phone)}&session=${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);
    return this.request<{ numberExists: boolean; chatId?: string }>(
      'GET',
      url,
      headers,
    );
  }

  /**
   * Resolve a caller-supplied chatId to the canonical WAHA chatId WhatsApp will
   * actually route to. Phone-number targets (bare digits, `@c.us`,
   * `@s.whatsapp.net`) are run through WAHA's check-exists, which fixes common
   * mis-addressing — notably Brazilian numbers sent with the extra "9th digit"
   * and LID-migrated contacts — that otherwise silently stall at PENDING.
   *
   * Group (`@g.us`) and LID (`@lid`) targets are already routable identities and
   * pass through untouched. On any failure (number not on WhatsApp, WAHA error)
   * the original chatId is returned, so this never regresses existing behavior.
   */
  async resolveChatId(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
    chatId: string,
  ): Promise<string> {
    if (typeof chatId !== 'string' || !chatId) return chatId;
    // Already-routable identities — never rewrite them.
    if (chatId.endsWith('@g.us') || chatId.endsWith('@lid')) return chatId;
    // Extract phone digits (drops '+', spaces, and the @c.us/@s.whatsapp.net suffix).
    const digits = chatId.replace(/@[a-z.]+$/i, '').replace(/\D/g, '');
    if (!digits) return chatId;

    const cacheKey = `${sessionName}:${digits}`;
    const now = Date.now();
    const cached = this.chatIdCache.get(cacheKey);
    if (cached && cached.exp > now) return cached.chatId;

    try {
      const res = await this.checkNumberExists(
        workerUrl,
        apiKey,
        sessionName,
        digits,
      );
      if (res?.numberExists && res.chatId) {
        if (this.chatIdCache.size >= this.CHATID_CACHE_MAX) {
          this.chatIdCache.clear();
        }
        this.chatIdCache.set(cacheKey, {
          chatId: res.chatId,
          exp: now + this.CHATID_CACHE_TTL_MS,
        });
        if (res.chatId !== chatId) {
          this.logger.log(
            `Resolved send target ${chatId} → ${res.chatId} (session "${sessionName}")`,
          );
        }
        return res.chatId;
      }
    } catch (error) {
      this.logger.warn(
        `chatId resolution failed for "${chatId}" on session "${sessionName}": ${error instanceof Error ? error.message : String(error)} — sending as-is`,
      );
    }
    return chatId;
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
    offset: number = 0,
  ): Promise<any[]> {
    const url = this.buildUrl(
      workerUrl,
      // downloadMedia=true so WAHA attaches hasMedia/media (incl. a fetchable
      // file URL) for audio/image/video/document messages. With false, media
      // messages come back with no media payload at all — which breaks the
      // media proxy and makes voice notes invisible to read-API consumers.
      `/api/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}&downloadMedia=true`,
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
    chatId = await this.resolveChatId(workerUrl, apiKey, sessionName, chatId);
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
