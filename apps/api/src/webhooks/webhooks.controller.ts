import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Inject,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { webhookConfigs, webhookEventLogs, wahaSessions } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { CreateWebhookDto, UpdateWebhookDto } from './webhooks.dto';

@Controller()
@UseGuards(AuthGuard)
export class WebhooksController {
  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  /**
   * List all webhook configs for a connection.
   */
  @Get('connections/:connectionId/webhooks')
  async listWebhooks(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: { sub: string },
  ) {
    await this.verifyConnectionOwnership(connectionId, user.sub);

    const results = await this.db
      .select()
      .from(webhookConfigs)
      .where(eq(webhookConfigs.sessionId, connectionId));

    return results;
  }

  /**
   * Create a new webhook config for a connection.
   */
  @Post('connections/:connectionId/webhooks')
  async createWebhook(
    @Param('connectionId') connectionId: string,
    @Body() dto: CreateWebhookDto,
    @CurrentUser() user: { sub: string },
  ) {
    await this.verifyConnectionOwnership(connectionId, user.sub);

    const signingSecret = randomBytes(32).toString('hex');

    const [created] = await this.db
      .insert(webhookConfigs)
      .values({
        userId: user.sub,
        sessionId: connectionId,
        url: dto.url,
        events: dto.events,
        signingSecret,
      })
      .returning();

    return created;
  }

  /**
   * Update an existing webhook config.
   */
  @Put('webhooks/:id')
  async updateWebhook(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
    @CurrentUser() user: { sub: string },
  ) {
    const config = await this.findWebhookConfigOrFail(id);

    if (config.userId !== user.sub) {
      throw new ForbiddenException('You do not own this webhook config');
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (dto.url !== undefined) {
      updateData.url = dto.url;
    }
    if (dto.events !== undefined) {
      updateData.events = dto.events;
    }
    if (dto.active !== undefined) {
      updateData.active = dto.active;
    }

    const [updated] = await this.db
      .update(webhookConfigs)
      .set(updateData)
      .where(eq(webhookConfigs.id, id))
      .returning();

    return updated;
  }

  /**
   * Delete a webhook config.
   */
  @Delete('webhooks/:id')
  async deleteWebhook(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const config = await this.findWebhookConfigOrFail(id);

    if (config.userId !== user.sub) {
      throw new ForbiddenException('You do not own this webhook config');
    }

    await this.db
      .delete(webhookConfigs)
      .where(eq(webhookConfigs.id, id));

    return { success: true };
  }

  /**
   * Get event logs for a webhook config.
   */
  @Get('webhooks/:id/logs')
  async getWebhookLogs(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    const config = await this.findWebhookConfigOrFail(id);

    if (config.userId !== user.sub) {
      throw new ForbiddenException('You do not own this webhook config');
    }

    const logs = await this.db
      .select()
      .from(webhookEventLogs)
      .where(eq(webhookEventLogs.webhookConfigId, id))
      .orderBy(desc(webhookEventLogs.createdAt))
      .limit(100);

    return logs;
  }

  /**
   * Verify that the connection (wahaSession) exists and belongs to the user.
   */
  private async verifyConnectionOwnership(
    connectionId: string,
    userId: string,
  ) {
    const [connection] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, connectionId));

    if (!connection) {
      throw new NotFoundException('Connection not found');
    }

    if (connection.userId !== userId) {
      throw new ForbiddenException('You do not own this connection');
    }

    return connection;
  }

  /**
   * Find a webhook config by ID or throw NotFoundException.
   */
  private async findWebhookConfigOrFail(id: string) {
    const [config] = await this.db
      .select()
      .from(webhookConfigs)
      .where(eq(webhookConfigs.id, id));

    if (!config) {
      throw new NotFoundException('Webhook config not found');
    }

    return config;
  }
}
