import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Inject,
  UseGuards,
  Logger,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, and, ne, inArray, desc } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { wahaSessions } from '@wahooks/db';
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
   */
  @Post('get-or-create')
  async getOrCreateScannable(@CurrentUser() user: { sub: string }) {
    // 1. Look for an existing idle connection (scan_qr, pending, or failed)
    const idleStatuses: ('scan_qr' | 'pending' | 'failed')[] = ['scan_qr', 'pending', 'failed'];
    const [idle] = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          inArray(wahaSessions.status, idleStatuses),
        ),
      )
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

    try {
      return await this.wahaService.getChats(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );
    } catch {
      return [];
    }
  }

  @Get(':id/chats/:chatId/messages')
  async getMessages(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
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
      return [];
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    try {
      return await this.wahaService.getMessages(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        chatId,
      );
    } catch {
      return [];
    }
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
    @Body() body: { chatId: string; text: string },
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
        'No worker assigned to this connection',
      );
    }

    const wahaName = this.wahaService.resolveSessionName(
      connection.sessionName,
    );

    return this.wahaService.sendText(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
      body.chatId,
      body.text,
    );
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
    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) throw new ServiceUnavailableException('No worker assigned');
    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);
    return { worker, wahaName };
  }

  @Post(':id/send-image')
  async sendImage(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; caption?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendImage(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.caption, body.data, body.mimetype,
    );
  }

  @Post(':id/send-document')
  async sendDocument(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; filename?: string; caption?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendFile(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.filename, body.caption, body.data, body.mimetype,
    );
  }

  @Post(':id/send-video')
  async sendVideo(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string; caption?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendVideo(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.caption, body.data, body.mimetype,
    );
  }

  @Post(':id/send-audio')
  async sendAudio(
    @Param('id') id: string,
    @Body() body: { chatId: string; url?: string; data?: string; mimetype?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendVoice(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.url, body.data, body.mimetype,
    );
  }

  @Post(':id/send-location')
  async sendLocation(
    @Param('id') id: string,
    @Body() body: { chatId: string; latitude: number; longitude: number; name?: string; address?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendLocation(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.latitude, body.longitude, body.name, body.address,
    );
  }

  @Post(':id/send-contact')
  async sendContact(
    @Param('id') id: string,
    @Body() body: { chatId: string; contactName: string; contactPhone: string },
    @CurrentUser() user: { sub: string },
  ) {
    const { worker, wahaName } = await this.resolveWorker(id, user.sub);
    return this.wahaService.sendContactVcard(
      worker.internalIp, worker.apiKeyEnc, wahaName,
      body.chatId, body.contactName, body.contactPhone,
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
