import {
  Controller,
  Get,
  Post,
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
import { eq, and, ne } from 'drizzle-orm';
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

    return results;
  }

  @Post()
  async createConnection(@CurrentUser() user: { sub: string }) {
    // Check billing: user must have available connection slots
    const [dbUser] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, user.sub));

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
    } else if (!dbUser?.isAdmin) {
      // No Stripe customer and not admin — must set up billing first
      throw new ForbiddenException(
        'Set up billing before creating connections. Visit /billing to get started.',
      );
    }

    // WAHA limits session names to 54 chars; use short hex IDs
    const shortUserId = user.sub.replace(/-/g, '').slice(0, 12);
    const shortSessionId = randomBytes(6).toString('hex');
    const sessionName = `u_${shortUserId}_s_${shortSessionId}`;

    const [created] = await this.db
      .insert(wahaSessions)
      .values({
        userId: user.sub,
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

      return updated;
    } catch (error) {
      this.logger.warn(
        `WAHA session deferred for connection ${created.id} (worker may still be booting). Health check will auto-create. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return created;
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
          await this.db
            .update(wahaSessions)
            .set({ status: 'working', updatedAt: new Date() })
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

  @Post(':id/send-media')
  async sendMedia(
    @Param('id') id: string,
    @Body() body: { chatId: string; type: string; mediaUrl?: string; mediaData?: string; mimetype?: string; caption?: string; filename?: string },
    @CurrentUser() user: { sub: string },
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, id));

    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.userId !== user.sub) throw new ForbiddenException('You do not own this connection');

    const worker = await this.workersService.getWorkerForSession(id);
    if (!worker) throw new ServiceUnavailableException('No worker assigned');

    const wahaName = this.wahaService.resolveSessionName(connection.sessionName);

    switch (body.type) {
      case 'image':
        return this.wahaService.sendImage(
          worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId,
          body.mediaUrl, body.caption, body.mediaData, body.mimetype,
        );
      case 'file':
        return this.wahaService.sendFile(
          worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId,
          body.mediaUrl, body.filename, body.caption, body.mediaData, body.mimetype,
        );
      case 'voice':
        return this.wahaService.sendVoice(
          worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId,
          body.mediaUrl, body.mediaData, body.mimetype,
        );
      default:
        return this.wahaService.sendFile(
          worker.internalIp, worker.apiKeyEnc, wahaName, body.chatId,
          body.mediaUrl, body.filename, body.caption, body.mediaData, body.mimetype,
        );
    }
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

    return connection;
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
