import { Controller, Post, Body, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and, not } from 'drizzle-orm';
import { wahaSessions, webhookConfigs, webhookEventLogs } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { EventsGateway } from './events.gateway';

interface WahaEvent {
  event: string;
  session: string;
  payload?: unknown;
  [key: string]: unknown;
}

@SkipThrottle()
@Controller('events')
export class EventsController {
  private readonly logger = new Logger(EventsController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
    private readonly wahaService: WahaService,
    private readonly eventsGateway: EventsGateway,
    private readonly configService: ConfigService,
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
    // WAHA Core (single session) always reports session name as "default",
    // but the DB stores the full name (e.g. u_xxx_s_yyy). In Core mode,
    // find the single active/working session instead.
    let session: any;
    if (
      event.session === 'default' &&
      this.wahaService.getMaxSessions() === 1
    ) {
      const sessions = await this.db
        .select()
        .from(wahaSessions)
        .where(not(eq(wahaSessions.status, 'stopped')))
        .limit(1);
      session = sessions[0];
    } else {
      const sessions = await this.db
        .select()
        .from(wahaSessions)
        .where(eq(wahaSessions.sessionName, event.session));
      session = sessions[0];
    }

    if (!session) {
      this.logger.warn(
        `No session found for sessionName: ${event.session}, ignoring event`,
      );
      return { received: true };
    }

    // 1b. session.status events carry the live connection state. Reflect it in
    // the DB immediately so SDK/web pollers (GET /connections, GET /:id) see the
    // scan → working transition in ~100ms instead of waiting up to 3 minutes for
    // the health cron to reconcile. WAHA pushes these because we subscribe to '*'.
    if (event.event === 'session.status') {
      const p = event.payload as any;
      await this.applySessionStatus(session, p?.status, p?.me?.id);
    }

    // 2. Rewrite internal WAHA media URLs to the externally-resolvable proxy URL.
    // Applies to both WebSocket broadcasts AND outbound webhook deliveries so
    // customers can fetch media without exposing internal WAHA worker hostnames.
    const rewrittenPayload = { ...(event.payload as any) };
    if (rewrittenPayload.media?.url) {
      const filename = rewrittenPayload.media.url.split('/').pop();
      const apiUrl = this.configService.get<string>('API_URL', 'http://localhost:3001');
      rewrittenPayload.media = {
        ...rewrittenPayload.media,
        url: `${apiUrl}/api/connections/${session.id}/media/${filename}`,
      };
    }
    const rewrittenEvent = { ...event, payload: rewrittenPayload };

    this.eventsGateway.broadcastEvent(session.id, session.userId, {
      event: event.event,
      connectionId: session.id,
      payload: rewrittenPayload,
      timestamp: new Date().toISOString(),
    });

    // 3. Find all active webhook configs for this session
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
          payload: rewrittenEvent,
          status: 'pending',
        })
        .returning();

      await this.webhookQueue.add('deliver', {
        webhookConfigId: config.id,
        url: config.url,
        signingSecret: config.signingSecret,
        eventType: event.event,
        payload: rewrittenEvent,
        sessionId: session.id,
        logId: log.id,
      });

      this.logger.log(
        `Enqueued webhook delivery ${log.id} to ${config.url} for event ${event.event}`,
      );
    }

    return { received: true };
  }

  /**
   * Map a live WAHA engine status onto our DB session status and persist it if
   * it changed. Deliberately narrow: we only act on the three states that have
   * an unambiguous DB equivalent.
   *
   * WAHA STOPPED is intentionally NOT handled here — our 'stopped' status means
   * "soft-deleted by the user", which is different from WAHA pausing a session.
   * The health cron owns the STOPPED → reset reconciliation.
   */
  private async applySessionStatus(
    session: any,
    wahaStatus: string | undefined,
    meId: string | undefined,
  ): Promise<void> {
    const map: Record<string, string> = {
      WORKING: 'working',
      SCAN_QR_CODE: 'scan_qr',
      FAILED: 'failed',
    };
    const newStatus = wahaStatus ? map[wahaStatus] : undefined;
    if (!newStatus) return;

    // Opportunistically capture the phone number if WAHA included it and we
    // don't have it yet. If absent, the QR endpoint / health cron backfill it.
    const phoneFromEvent = meId ? meId.replace('@c.us', '') : undefined;

    const needsStatus = session.status !== newStatus;
    const needsPhone = newStatus === 'working' && !session.phoneNumber && !!phoneFromEvent;
    if (!needsStatus && !needsPhone) return;

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (needsStatus) updates.status = newStatus;
    if (needsPhone) updates.phoneNumber = phoneFromEvent;

    await this.db
      .update(wahaSessions)
      .set(updates)
      .where(eq(wahaSessions.id, session.id));

    this.logger.log(
      `session.status: ${session.sessionName} ${session.status} → ${newStatus} (via WAHA event)`,
    );
  }
}
