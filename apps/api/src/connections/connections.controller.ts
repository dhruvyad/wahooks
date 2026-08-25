import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Inject,
  UseGuards,
  Logger,
  NotFoundException,
  ForbiddenException,
  GoneException,
  ServiceUnavailableException,
  BadRequestException,
  Header,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, ne, inArray, desc, isNull, notExists } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { wahaSessions, webhookConfigs } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WorkersService } from '../workers/workers.service';
import { WahaService } from '../waha/waha.service';
import { StripeService } from '../billing/stripe.service';
import { users } from '@wahooks/db';

@Controller('connections')
@UseGuards(AuthGuard)
export class ConnectionsController {
  private readonly logger = new Logger(ConnectionsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly workersService: WorkersService,
    private readonly wahaService: WahaService,
    private readonly configService: ConfigService,
    private readonly stripeService: StripeService,
  ) {}

  /** Map internal status names to user-friendly ones */
  private mapStatus(status: string): string {
    if (status === 'working') return 'connected';
    return status;
  }

  private mapConnection(conn: any): any {
    return { ...conn, status: this.mapStatus(conn.status) };
  }

  // --- Read-API shaping helpers (normalize WAHA payloads into our canonical types) ---

  private clampLimit(raw: string | undefined, def: number, max: number): number {
    const n = parseInt(raw ?? '', 10);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(n, max);
  }

  /** Opaque cursor = base64url of a numeric offset. */
  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset)).toString('base64url');
  }

  private decodeCursor(before: string | undefined): number {
    if (!before) return 0;
    const n = parseInt(Buffer.from(before, 'base64url').toString('utf8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Rewrite an internal WAHA media URL to our authenticated media-proxy URL. */
  private mediaProxyUrl(sessionId: string, wahaMediaUrl: string): string {
    const filename = wahaMediaUrl.split('/').pop();
    const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
    return `${apiUrl}/api/connections/${sessionId}/media/${filename}`;
  }

  private normalizeJid(jid: string | null | undefined): string | null {
    if (!jid) return null;
    // Strip device suffix: "918383880642:3@s.whatsapp.net" -> "918383880642@s.whatsapp.net"
    return jid.replace(/:\d+@/, '@');
  }

  private deriveMessageType(raw: any): string {
    if (raw?.location) return 'location';
    if (raw?.vCards) return 'contact';
    const mime: string | undefined = raw?.media?.mimetype;
    if (raw?.hasMedia && mime) {
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      return 'document';
    }
    return 'text';
  }

  private mapMessage(raw: any, sessionId: string, chatIdFallback?: string): any {
    const participant =
      raw?._data?.participant ?? raw?._data?.key?.participant ?? null;
    const senderJid = raw?.fromMe
      ? null
      : this.normalizeJid(participant ?? raw?.from ?? null);
    const quoted = raw?.replyTo;
    const quotedMessageId =
      typeof quoted === 'string' ? quoted : (quoted?.id ?? null);
    const media =
      raw?.hasMedia && raw?.media?.url
        ? {
            url: this.mediaProxyUrl(sessionId, raw.media.url),
            mimetype: raw.media.mimetype,
            filename: raw.media.filename,
            size: raw.media.size,
          }
        : null;

    return {
      id: raw?.id,
      chatId: raw?.from ?? chatIdFallback ?? null,
      timestamp: raw?.timestamp,
      fromMe: !!raw?.fromMe,
      senderJid,
      senderPushName: raw?._data?.pushName ?? raw?._data?.notifyName ?? null,
      type: this.deriveMessageType(raw),
      text: raw?.body ?? null,
      quotedMessageId,
      media,
    };
  }

  private mapChat(raw: any): any {
    const id: string = raw?.id;
    const lm = raw?.lastMessage;
    return {
      id,
      name: raw?.name ?? null,
      isGroup: typeof id === 'string' && id.endsWith('@g.us'),
      lastMessage: lm
        ? { body: lm.body ?? null, timestamp: lm.timestamp, fromMe: !!lm.fromMe }
        : null,
      unread: !!(
        raw?._chat?.markedAsUnread || (raw?._chat?.unreadMentionCount ?? 0) > 0
      ),
    };
  }

  private mapContact(raw: any): any {
    const id: string = raw?.id;
    const phoneRaw: string | undefined = raw?.phoneNumber;
    let phoneNumber: string | null = null;
    if (phoneRaw) {
      phoneNumber = phoneRaw.replace(/@.*/, '');
    } else if (typeof id === 'string' && id.endsWith('@c.us')) {
      phoneNumber = id.replace('@c.us', '');
    }
    return {
      jid: id,
      name: raw?.name ?? null,
      phoneNumber,
      isGroup: typeof id === 'string' && id.endsWith('@g.us'),
    };
  }

  @Get()
  async listConnections(@CurrentUser() user: { sub: string }) {
    const results = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          ne(wahaSessions.status, 'stopped'),
        ),
      );

    return results.map((c: any) => this.mapConnection(c));
  }

  /**
   * Get a connection ready to scan, reusing an idle one if available.
   * Returns { id, status, qr } — one call, one response.
   *
   * `virgin_only` restricts reuse to sessions that were never phone-linked and
   * have no webhook configs. Multi-tenant consumers (one WAHooks account, many
   * end users) must set it: a recycled session keeps its webhook configs, and
   * the phone link happens at scan time — so handing a previously-linked
   * session's QR to a new end user attaches their phone to another end user's
   * delivery pipeline.
   */
  @Post('get-or-create')
  async getOrCreateScannable(
    @CurrentUser() user: { sub: string },
    @Body() body?: { virgin_only?: boolean },
  ) {
    // 1. Look for an existing idle connection (scan_qr, pending, or failed)
    const idleStatuses: ('scan_qr' | 'pending' | 'failed')[] = ['scan_qr', 'pending', 'failed'];
    const idleWhere = [
      eq(wahaSessions.userId, user.sub),
      inArray(wahaSessions.status, idleStatuses),
    ];
    if (body?.virgin_only) {
      idleWhere.push(
        isNull(wahaSessions.phoneNumber),
        notExists(
          this.db
            .select({ id: webhookConfigs.id })
            .from(webhookConfigs)
            .where(eq(webhookConfigs.sessionId, wahaSessions.id)),
        ),
      );
    }
    const [idle] = await this.db
      .select()
      .from(wahaSessions)
      .where(and(...idleWhere))
      .orderBy(desc(wahaSessions.createdAt))
      .limit(1);

    let connectionId: string;

    if (idle) {
      // 2a. Reuse existing — restart it
      this.logger.log(`Reusing idle connection ${idle.id} (status: ${idle.status})`);
      connectionId = idle.id;

      const worker = await this.workersService.getWorkerForSession(idle.id);
      if (worker) {
        const wahaName = this.wahaService.resolveSessionName(idle.sessionName);
        const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
        const webhookUrl = `${apiUrl}/api/events/waha`;
        await this.wahaService.resetSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
          webhookUrl,
        );
        await this.db
          .update(wahaSessions)
          .set({ status: 'scan_qr', updatedAt: new Date() })
          .where(eq(wahaSessions.id, idle.id));
      }
    } else {
      // 2b. No idle connection — create a new one
      const created = await this.createConnection(user);
      connectionId = created.id;
    }

    // 3. Poll for QR (up to 10 attempts, 2s apart)
    for (let i = 0; i < 10; i++) {
      try {
        const qr = await this.getQrCode(connectionId, user);
        if (qr && 'connected' in qr && qr.connected) {
          return { id: connectionId, status: 'connected', qr: null };
        }
        if (qr && 'value' in qr) {
          return { id: connectionId, status: 'scan_qr', qr: qr.value };
        }
      } catch {
        // Worker not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Return without QR if polling timed out — client can fetch it separately
    return { id: connectionId, status: 'pending', qr: null };
  }

  @Post()
  async createConnection(
    @CurrentUser() user: { sub: string },
    @Body() body?: { name?: string },
  ) {
    // Check billing: user must have available connection slots
    const [dbUser] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, user.sub));

    if (!dbUser?.isAdmin) {
      if (dbUser?.stripeCustomerId) {
        const paidSlots = await this.stripeService.getPaidSlots(dbUser.stripeCustomerId);
        const activeConns = await this.db
          .select()
          .from(wahaSessions)
          .where(and(eq(wahaSessions.userId, user.sub), ne(wahaSessions.status, 'stopped')));

        if (activeConns.length >= paidSlots) {
          throw new ForbiddenException(
            `All ${paidSlots} connection slots in use. Buy more slots at /billing.`,
          );
        }
      } else {
        throw new ForbiddenException(
          'Set up billing before creating connections. Visit /billing to get started.',
        );
      }
    }

    // WAHA limits session names to 54 chars; use short hex IDs
    const shortUserId = user.sub.replace(/-/g, '').slice(0, 12);
    const shortSessionId = randomBytes(6).toString('hex');
    const sessionName = `u_${shortUserId}_s_${shortSessionId}`;

    const [created] = await this.db
      .insert(wahaSessions)
      .values({
        userId: user.sub,
        name: body?.name || null,
        sessionName,
        status: 'pending',
        engine: 'NOWEB',
      })
      .returning();

    try {
      // Timeout worker provisioning at 15s — if it takes longer,
      // the connection stays pending and the health service will assign it.
      const worker = await Promise.race([
        this.workersService.findOrProvisionWorker(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Worker provisioning timeout')), 15000),
        ),
      ]);
      await this.workersService.assignSession(worker.id, created.id);
      const apiUrl = this.configService.get<string>(
        'API_URL',
        'http://localhost:3001',
      );
      const webhookUrl = `${apiUrl}/api/events/waha`;
      const wahaName = this.wahaService.resolveSessionName(sessionName);

      // Clean up any existing session on this worker before creating a new one.
      // In WAHA Core mode (1 session/pod), there can only be one session named "default".
      try {
        await this.wahaService.getSession(
          worker.internalIp,
          worker.apiKey,
          wahaName,
        );
        // Session exists — delete it so we can create fresh with full config
        this.logger.log(
          `Existing WAHA session "${wahaName}" found, cleaning up before re-create`,
        );
        try {
          await this.wahaService.stopSession(
            worker.internalIp,
            worker.apiKey,
            wahaName,
          );
        } catch {
          // Ignore
        }
        try {
          await this.wahaService.logoutSession(
            worker.internalIp,
            worker.apiKey,
            wahaName,
          );
        } catch {
          // Ignore
        }
        try {
          await this.wahaService.deleteSession(
            worker.internalIp,
            worker.apiKey,
            wahaName,
          );
        } catch {
          // Ignore
        }
      } catch {
        // Session doesn't exist yet — fine
      }

      await this.wahaService.createSession(
        worker.internalIp,
        worker.apiKey,
        wahaName,
        webhookUrl,
      );
      await this.wahaService.startSession(
        worker.internalIp,
        worker.apiKey,
        wahaName,
      );

      const [updated] = await this.db
        .update(wahaSessions)
        .set({ status: 'scan_qr', updatedAt: new Date() })
        .where(eq(wahaSessions.id, created.id))
        .returning();

      return this.mapConnection(updated);
    } catch (error) {
      this.logger.warn(
        `WAHA session deferred for connection ${created.id} (worker may still be booting). Health check will auto-create. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.mapConnection(created);
    }
  }

  @Get(':id/qr')
  async getQrCode(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      throw new ServiceUnavailableException(
        'Worker is being provisioned, please wait',
      );
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    try {
      const qr = await this.wahaService.getQrCode(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );
      return qr;
    } catch {
      // QR fetch failed — check session status
      try {
        const session = await this.wahaService.getSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
        );
        if (session.status === 'WORKING') {
          const updates: Record<string, any> = { status: 'working', updatedAt: new Date() };
          try {
            const me = await this.wahaService.getMe(worker.internalIp, worker.apiKeyEnc, wahaName);
            const phone = me?.id?.replace('@c.us', '') || null;
            if (phone) updates.phoneNumber = phone;
          } catch { /* non-critical */ }
          await this.db
            .update(wahaSessions)
            .set(updates)
            .where(eq(wahaSessions.id, id));
          return { connected: true };
        }
        if (session.status === 'FAILED' || session.status === 'STOPPED') {
          this.logger.log(
            `Session ${wahaName} is ${session.status}, resetting with full config...`,
          );
          const apiUrl = this.configService.get<string>(
            'API_URL',
            'http://localhost:3001',
          );
          const webhookUrl = `${apiUrl}/api/events/waha`;
          await this.wahaService.resetSession(
            worker.internalIp,
            worker.apiKeyEnc,
            wahaName,
            webhookUrl,
          );
          await this.db
            .update(wahaSessions)
            .set({ status: 'scan_qr', updatedAt: new Date() })
            .where(eq(wahaSessions.id, id));
        }
      } catch {
        // Session check also failed — worker is genuinely unavailable
      }
      throw new ServiceUnavailableException(
        'Worker is starting up, please wait',
      );
    }
  }

  @Post(':id/restart')
  async restartConnection(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      throw new NotFoundException('No worker assigned to this connection');
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    const apiUrl = this.configService.get<string>(
      'API_URL',
      'http://localhost:3001',
    );
    const webhookUrl = `${apiUrl}/api/events/waha`;

    // Always do a full reset to ensure webhook URL and store config are preserved.
    // restartSession doesn't re-apply config, so webhooks silently break after pod restarts.
    await this.wahaService.resetSession(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      webhookUrl,
    );

    const [updated] = await this.db
      .update(wahaSessions)
      .set({ status: 'scan_qr', updatedAt: new Date() })
      .where(eq(wahaSessions.id, id))
      .returning();

    return updated;
  }

  @Get(':id/chats')
  async getChats(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('unread_only') unreadOnly?: string,
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      return [];
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    const limit = this.clampLimit(limitRaw, 50, 100);
    const offset = Math.max(0, parseInt(offsetRaw ?? '0', 10) || 0);

    try {
      const raw = await this.wahaService.getChatsOverview(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        limit,
        offset,
      );
      let chats = (raw ?? []).map((c) => this.mapChat(c));
      if (unreadOnly === 'true' || unreadOnly === '1') {
        chats = chats.filter((c) => c.unread);
      }
      return chats;
    } catch {
      return [];
    }
  }

  @Get(':id/contacts')
  async getContacts(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== user.sub)
      throw new ForbiddenException('You do not own this connection');

    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) return [];

    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);
    const limit = this.clampLimit(limitRaw, 500, 2000);
    const offset = Math.max(0, parseInt(offsetRaw ?? '0', 10) || 0);

    try {
      const raw = await this.wahaService.getContacts(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        limit,
        offset,
      );
      return (raw ?? []).map((c) => this.mapContact(c));
    } catch {
      return [];
    }
  }

  @Get(':id/chats/:chatId/messages')
  async getMessages(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @CurrentUser() user: { sub: string },
    @Query('limit') limitRaw?: string,
    @Query('before') before?: string,
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const empty = { messages: [], nextBefore: null, historyStartsAt: null };

    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) return empty;

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    const limit = this.clampLimit(limitRaw, 50, 200);
    const offset = this.decodeCursor(before);

    try {
      const raw = await this.wahaService.getMessages(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        chatId,
        limit,
        offset,
      );
      const rows = raw ?? [];
      const messages = rows.map((m) => this.mapMessage(m, id, chatId));
      // Messages are newest-first. A short page means we hit the bottom of history.
      const reachedEnd = rows.length < limit;
      const oldest = messages.length ? messages[messages.length - 1] : null;
      return {
        messages,
        nextBefore: reachedEnd ? null : this.encodeCursor(offset + limit),
        historyStartsAt: reachedEnd && oldest ? oldest.timestamp : null,
      };
    } catch {
      return empty;
    }
  }

  @Get(':id/messages/:messageId')
  async getMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: { sub: string },
    @Query('chatId') chatId?: string,
  ) {
    if (!chatId) {
      throw new BadRequestException('chatId query param is required');
    }
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    try {
      const raw = await this.wahaService.getMessage(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        chatId,
        messageId,
      );
      if (!raw) throw new NotFoundException('Message not found');
      return this.mapMessage(raw, id, chatId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new NotFoundException('Message not found');
    }
  }

  @Put(':id/messages/:messageId')
  async editMessage(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: { chatId: string; text: string },
    @CurrentUser() user: { sub: string },
  ) {
    if (!body?.chatId || typeof body?.text !== 'string') {
      throw new BadRequestException('chatId and text are required');
    }
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    try {
      await this.wahaService.editMessage(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        body.chatId,
        messageId,
        body.text,
      );
      return { success: true };
    } catch {
      // WhatsApp only allows editing your own messages within ~15 minutes.
      throw new BadRequestException(
        'Could not edit message. WhatsApp only allows editing your own messages within ~15 minutes of sending.',
      );
    }
  }

  @Get(':id/messages/:messageId/media')
  async getMessageMedia(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: { sub: string },
    @Query('chatId') chatId?: string,
  ): Promise<StreamableFile> {
    if (!chatId) {
      throw new BadRequestException('chatId query param is required');
    }
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);

    let raw: any;
    try {
      raw = await this.wahaService.getMessage(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        chatId,
        messageId,
      );
    } catch {
      throw new NotFoundException('Message not found');
    }

    const wahaMediaUrl: string | undefined = raw?.media?.url;
    if (!raw?.hasMedia || !wahaMediaUrl) {
      throw new NotFoundException('Message has no media');
    }

    const filename = wahaMediaUrl.split('/').pop();
    if (!filename) throw new NotFoundException('Media not found');

    // Media lives on the worker's local disk and keys expire — a 404 here means
    // it has aged out (proxy-only; no durable blob store in this phase).
    return this.streamWorkerFile(worker, wahaName, filename);
  }

  @Get(':id/me')
  async getMe(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    const worker = await this.workersService.getWorkerForSession(id);

    if (!worker) {
      return null;
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    try {
      return await this.wahaService.getMe(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );
    } catch {
      return null;
    }
  }

  @Get(':id/contacts/:contactId/picture')
  async getContactPicture(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== user.sub) throw new ForbiddenException('You do not own this connection');

    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) return { profilePictureUrl: null };

    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);
    return this.wahaService.getProfilePicture(
      worker.internalIp, worker.apiKeyEnc, wahaName, contactId,
    );
  }

  @Post(':id/send')
  async sendText(
    @Param('id') id: string,
    @Body() body: { chatId: string; text: string; skipPresence?: boolean; replyTo?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);

    const raw = await this.wahaService.sendText(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      body.chatId,
      body.text,
      { skipPresence: body.skipPresence, replyTo: body.replyTo },
    );
    return this.normalizeSendResult(raw);
  }

  /**
   * Add a top-level, edit-ready `id` (and `timestamp`) to WAHA's raw send response.
   * WAHA returns the Baileys `key` ({ remoteJid, id, fromMe }); the edit endpoint needs
   * the serialized form `{fromMe}_{chatId}_{id}`. Additive — raw fields are preserved.
   */
  private normalizeSendResult(raw: any): any {
    const key = raw?.key;
    if (key?.id && key?.remoteJid) {
      const fromMe = key.fromMe ? 'true' : 'false';
      const jid = String(key.remoteJid).replace('@s.whatsapp.net', '@c.us');
      const ts = Number(raw?.messageTimestamp);
      return {
        ...raw,
        id: `${fromMe}_${jid}_${key.id}`,
        timestamp: Number.isFinite(ts) ? ts : undefined,
      };
    }
    return raw;
  }

  @Post(':id/react')
  async sendReaction(
    @Param('id') id: string,
    @Body() body: { chatId: string; messageId: string; reaction: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.sendReaction(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      body.chatId,
      body.messageId,
      body.reaction,
    );
    return { success: true };
  }

  @Get(':id/media/:filename')
  async getMedia(
    @Param('id') id: string,
    @Param('filename') filename: string,
    @CurrentUser() user: { sub: string },
  ): Promise<StreamableFile> {
    // Sanitize filename — reject path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new NotFoundException('Invalid filename');
    }

    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.streamWorkerFile(worker, wahaName, filename);
  }

  /** Fetch a media file from a WAHA worker's local file endpoint and return it as a stream. */
  private async streamWorkerFile(
    worker: any,
    wahaName: string,
    filename: string,
  ): Promise<StreamableFile> {
    const wahaUrl = `http://${worker.internalIp}:3000/api/files/${encodeURIComponent(wahaName)}/${encodeURIComponent(filename)}`;
    const wahaRes = await fetch(wahaUrl, {
      headers: { 'X-Api-Key': worker.apiKeyEnc },
    });

    if (!wahaRes.ok || !wahaRes.body) {
      throw new NotFoundException('Media not found');
    }

    const contentType = wahaRes.headers.get('content-type') || 'application/octet-stream';

    const chunks: Uint8Array[] = [];
    const reader = wahaRes.body.getReader();
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) chunks.push(result.value);
    }

    return new StreamableFile(Buffer.concat(chunks), { type: contentType });
  }

  @Post(':id/mark-read')
  async markRead(
    @Param('id') id: string,
    @Body() body: { chatId: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.sendSeen(worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId);
    return { success: true };
  }

  @Post(':id/typing')
  async startTyping(
    @Param('id') id: string,
    @Body() body: { chatId: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.startTyping(worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId);
    return { success: true };
  }

  @Post(':id/typing/stop')
  async stopTyping(
    @Param('id') id: string,
    @Body() body: { chatId: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    await this.wahaService.stopTyping(worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId);
    return { success: true };
  }

  @Patch(':id')
  async updateConnection(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== user.sub) throw new ForbiddenException('You do not own this connection');

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name || null;

    const [updated] = await this.db
      .update(wahaSessions)
      .set(updates)
      .where(eq(wahaSessions.id, id))
      .returning();

    return this.mapConnection(updated);
  }

  /** Resolve connection → worker → wahaName, with ownership check */
  private async resolveWorker(id: string, userId: string) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));
    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== userId) throw new ForbiddenException('You do not own this connection');
    // A deleted (soft-stopped) connection has no worker by design. Without this
    // check it surfaced as 503 'No worker assigned', which reads as a platform
    // outage and sends client retry loops hammering a permanently-dead id.
    if (connection.status === 'stopped') {
      throw new GoneException(
        'This connection was deleted. Create a new connection, link it by scanning the QR code, and update your integration to use the new connection id.',
      );
    }
    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) throw new ServiceUnavailableException('No worker assigned');
    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);
    return { worker, wahaName };
  }

  @Post(':id/send-image')
  async sendImage(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; caption?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    // WhatsApp does not support SVG as an image (clients can't render it and
    // thumbnail generation fails downstream). Fail fast with guidance instead
    // of letting the engine 500.
    const declaredMime =
      body.mimetype ??
      (body.url?.startsWith('data:') ? body.url.slice(5).split(/[;,]/)[0] : undefined);
    if (declaredMime?.toLowerCase().includes('svg')) {
      throw new BadRequestException(
        'WhatsApp does not support SVG images. Send the file via send-document instead, or convert it to PNG/JPEG first.',
      );
    }
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendImage(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.caption, body.data, body.mimetype,
      { skipPresence: body.skipPresence },
    );
  }

  @Post(':id/send-document')
  async sendDocument(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; filename?: string; caption?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendFile(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.filename, body.caption, body.data, body.mimetype,
      { skipPresence: body.skipPresence },
    );
  }

  @Post(':id/send-video')
  async sendVideo(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; caption?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendVideo(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.caption, body.data, body.mimetype,
      { skipPresence: body.skipPresence },
    );
  }

  @Post(':id/send-audio')
  async sendAudio(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendVoice(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.data, body.mimetype,
      { skipPresence: body.skipPresence },
    );
  }

  @Post(':id/send-location')
  async sendLocation(
    @Param('id') id: string,
    @Body() body: { chatId: string; latitude: number; longitude: number; name?: string; address?: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendLocation(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.latitude, body.longitude, body.name, body.address,
      { skipPresence: body.skipPresence },
    );
  }

  @Post(':id/send-contact')
  async sendContact(
    @Param('id') id: string,
    @Body() body: { chatId: string; contactName: string; contactPhone: string; skipPresence?: boolean },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendContactVcard(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.contactName, body.contactPhone,
      { skipPresence: body.skipPresence },
    );
  }

  @Get(':id')
  async getConnection(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    return this.mapConnection(connection);
  }

  @Delete(':id')
  async deleteConnection(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== user.sub) {
      throw new ForbiddenException('You do not own this connection');
    }

    try {
      const worker = await this.workersService.getWorkerForSession(id);

      if (worker) {
        const wahaName = this.wahaService.resolveSessionName(
          connection.sessionName,
        );
        // Full cleanup: stop → logout → delete (drops WAHA's per-session database)
        try {
          await this.wahaService.stopSession(worker.internalIp, worker.apiKeyEnc, wahaName);
        } catch { /* may already be stopped */ }
        try {
          await this.wahaService.logoutSession(worker.internalIp, worker.apiKeyEnc, wahaName);
        } catch { /* ignore */ }
        try {
          await this.wahaService.deleteSession(worker.internalIp, worker.apiKeyEnc, wahaName);
        } catch { /* ignore */ }
        await this.workersService.unassignSession(worker.id, id);
      }
    } catch (error) {
      this.logger.error(
        `Failed to stop WAHA session for connection ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const [updated] = await this.db
      .update(wahaSessions)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(wahaSessions.id, id))
      .returning();

    return updated;
  }
}
