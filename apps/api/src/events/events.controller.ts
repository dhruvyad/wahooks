import { Controller, Post, Body, Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { wahaSessions, webhookConfigs, webhookEventLogs } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';

interface WahaEvent {
  event: string;
  session: string;
  payload?: unknown;
  [key: string]: unknown;
}

@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
  ) {}

  /**
   * Ingestion endpoint for WAHA webhook events.
   * No auth guard — this receives internal traffic from WAHA worker containers.
   */
  @Post('waha')
  async ingestWahaEvent(@Body() event: WahaEvent) {
    this.logger.log(
      `Received WAHA event: ${event.event} for session: ${event.session}`,
    );

    // 1. Look up the session by sessionName
    const [session] = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.sessionName, event.session));

    if (!session) {
      this.logger.warn(
        `No session found for sessionName: ${event.session}, ignoring event`,
      );
      return { received: true };
    }

    // 2. Find all active webhook configs for this session
    const configs = await this.db
      .select()
      .from(webhookConfigs)
      .where(
        and(
          eq(webhookConfigs.sessionId, session.id),
          eq(webhookConfigs.active, true),
        ),
      );

    // 3. Filter configs whose events array contains the event type
    const matchingConfigs = configs.filter(
      (config: { events: string[] }) =>
        config.events.includes('*') || config.events.includes(event.event),
    );

    if (matchingConfigs.length === 0) {
      this.logger.debug(
        `No matching webhook configs for event ${event.event} on session ${session.id}`,
      );
      return { received: true };
    }

    // 4. For each matching config, create a log entry and enqueue a delivery job
    for (const config of matchingConfigs) {
      const [log] = await this.db
        .insert(webhookEventLogs)
        .values({
          webhookConfigId: config.id,
          eventType: event.event,
          payload: event,
          status: 'pending',
        })
        .returning();

      await this.webhookQueue.add('deliver', {
        webhookConfigId: config.id,
        url: config.url,
        signingSecret: config.signingSecret,
        eventType: event.event,
        payload: event,
        sessionId: session.id,
        logId: log.id,
      });

      this.logger.log(
        `Enqueued webhook delivery ${log.id} to ${config.url} for event ${event.event}`,
      );
    }

    return { received: true };
  }
}
