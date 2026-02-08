import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Inject,
  UseGuards,
  Logger,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { wahaSessions } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WorkersService } from '../workers/workers.service';
import { WahaService } from '../waha/waha.service';

@Controller('connections')
@UseGuards(AuthGuard)
export class ConnectionsController {
  private readonly logger = new Logger(ConnectionsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly workersService: WorkersService,
    private readonly wahaService: WahaService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  async listConnections(@CurrentUser() user: { sub: string }) {
    const results = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.userId, user.sub));

    return results;
  }

  @Post()
  async createConnection(@CurrentUser() user: { sub: string }) {
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
      const worker = await this.workersService.findOrProvisionWorker();
      await this.workersService.assignSession(worker.id, created.id);
      const apiUrl = this.configService.get<string>(
        'API_URL',
        'http://localhost:3001',
      );
      const webhookUrl = `${apiUrl}/api/events/waha`;
      const wahaName = this.wahaService.resolveSessionName(sessionName);
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
      // QR fetch failed — check if the session has moved past SCAN_QR_CODE
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
    await this.wahaService.restartSession(
      worker.internalIp,
      worker.apiKeyEnc,
      wahaName,
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
        await this.wahaService.stopSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
        );
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
