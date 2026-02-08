import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Inject,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { wahaSessions } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';

@Controller('connections')
@UseGuards(AuthGuard)
export class ConnectionsController {
  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

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

    return created;
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

    const [updated] = await this.db
      .update(wahaSessions)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(wahaSessions.id, id))
      .returning();

    return updated;
  }
}
