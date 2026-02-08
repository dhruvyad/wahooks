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
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
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
    const sessionName = `u_${user.sub}_s_${randomUUID()}`;

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
      await this.wahaService.createSession(
        worker.internalIp,
        worker.apiKey,
        sessionName,
      );
      await this.wahaService.startSession(
        worker.internalIp,
        worker.apiKey,
        sessionName,
      );

      const [updated] = await this.db
        .update(wahaSessions)
        .set({ status: 'scan_qr', updatedAt: new Date() })
        .where(eq(wahaSessions.id, created.id))
        .returning();

      return updated;
    } catch (error) {
      this.logger.error(
        `Failed to provision WAHA session for connection ${created.id}: ${error instanceof Error ? error.message : String(error)}`,
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
      throw new NotFoundException('No worker assigned to this connection');
    }

    const qr = await this.wahaService.getQrCode(
      worker.internalIp,
      worker.apiKeyEnc,
      connection.sessionName,
    );

    return qr;
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

    await this.wahaService.restartSession(
      worker.internalIp,
      worker.apiKeyEnc,
      connection.sessionName,
    );

    const [updated] = await this.db
      .update(wahaSessions)
      .set({ status: 'scan_qr', updatedAt: new Date() })
      .where(eq(wahaSessions.id, id))
      .returning();

    return updated;
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
        await this.wahaService.stopSession(
          worker.internalIp,
          worker.apiKeyEnc,
          connection.sessionName,
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
