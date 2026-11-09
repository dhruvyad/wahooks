import {
  Controller,
  Post,
  Body,
  Headers,
  Inject,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, and, not } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { wahaSessions, webhookConfigs } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { WorkersService } from '../workers/workers.service';
import { EventsGateway } from './events.gateway';
import { WebhookLogRetentionService } from './webhook-log-retention.service';
import { EVENTS_SECRET_HEADER, eventsSecretMatches } from './events-secret';

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

  private readonly lidPhoneCache = new Map<string, { phone: string | null; exp: number }>();
  private readonly LID_PHONE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly LID_UNKNOWN_TTL_MS = 10 * 60 * 1000;
  private readonly LID_PHONE_CACHE_MAX = 10_000;

  // Shared secret workers send in EVENTS_SECRET_HEADER. Gateway sessions must
  // send it; WAHA sessions don't yet, but one that does must send it right.
  private readonly eventsSecret: string | null;

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
    private readonly wahaService: WahaService,
    private readonly workersService: WorkersService,
    private readonly eventsGateway: EventsGateway,
    private readonly configService: ConfigService,
    private readonly logRetention: WebhookLogRetentionService,
  ) {
    this.eventsSecret = this.configService.get<string>('EVENTS_SECRET')?.trim() || null;
    if (!this.eventsSecret) {
      this.logger.warn(
        'EVENTS_SECRET is not set: POST /api/events/waha accepts any event that names a session',
      );
    }
  }

  /**
   * Ingestion endpoint for WAHA webhook events.
   * No auth guard — this receives internal traffic from WAHA worker containers
   * and gateway boxes. With EVENTS_SECRET set, gateway sessions must send it in
   * X-WAHooks-Events-Secret, and a header that is sent must match.
   */
  @Post('waha')
  async ingestWahaEvent(
    @Body() event: WahaEvent,
    @Headers(EVENTS_SECRET_HEADER.toLowerCase()) eventsSecret?: string,
  ) {
    this.logger.log(
      `Received WAHA event: ${event.event} for session: ${event.session}`,
    );

    // A wrong secret is refused before any lookup.
    if (this.eventsSecret && eventsSecret !== undefined) {
      if (!eventsSecretMatches(String(eventsSecret), this.eventsSecret)) {
        this.logger.warn(
          `Refused event for session ${this.logName(event.session)}: wrong ${EVENTS_SECRET_HEADER}`,
        );
        throw new UnauthorizedException();
      }
    }

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

    // No secret sent: fine for a WAHA session (as before), not for a gateway's.
    if (this.eventsSecret && eventsSecret === undefined && session.workerId) {
      let kind: string | null = null;
      try {
        kind = await this.workersService.getWorkerKind(session.workerId);
      } catch (error) {
        this.logger.warn(
          `Worker kind lookup failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (kind === 'gateway') {
        this.logger.warn(
          `Refused event for gateway session ${this.logName(event.session)}: no ${EVENTS_SECRET_HEADER}`,
        );
        throw new UnauthorizedException();
      }
    }

    // 1b. session.status events carry the live connection state. Reflect it in
    // the DB immediately so SDK/web pollers (GET /connections, GET /:id) see the
    // scan → working transition in ~100ms instead of waiting up to 3 minutes for
    // the health cron to reconcile. WAHA pushes these because we subscribe to '*'.
    if (event.event === 'session.status') {
      const p = event.payload as any;
      await this.applySessionStatus(session, p?.status, (event as any)?.me?.id ?? p?.me?.id, p?.statuses);
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
    // For message-family events, surface the sender's real phone number at the
    // top level as `senderPhone` (digits only). When the sender uses a WhatsApp
    // @lid (privacy identifier), `from` is the LID and the phone number JID lives
    // in `_data.key.remoteJidAlt` (`participantAlt` for group senders) — this
    // saves consumers from reaching into `_data`. WhatsApp doesn't always ship
    // that alt JID; the session's LID store is asked then. Original fields
    // (`from`, `_data`, …) are left untouched for backwards compatibility.
    if (typeof rewrittenPayload.from === 'string') {
      rewrittenPayload.senderPhone =
        this.resolveSenderPhone(rewrittenPayload) ??
        (await this.lookupLidSenderPhone(session, rewrittenPayload));
    }

    // connectionId lets webhook consumers map the event to the connection they
    // registered against without parsing session names (needed by NoClick's
    // session-death detection; the raw WAHA envelope only carries sessionName).
    const rewrittenEvent = { ...event, connectionId: session.id, payload: rewrittenPayload };

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

    // 4. For each matching config, enqueue a delivery job. Its log row is written by the delivery
    // processor when the first attempt ends (one write instead of an insert here and an update
    // there); the id is fixed now so every attempt updates the same row.
    const createdAt = new Date().toISOString();
    for (const config of matchingConfigs) {
      const logId = randomUUID();

      await this.webhookQueue.add('deliver', {
        webhookConfigId: config.id,
        url: config.url,
        signingSecret: config.signingSecret,
        eventType: event.event,
        payload: rewrittenEvent,
        sessionId: session.id,
        logId,
        createdAt,
      });
      this.logRetention.touch(config.id);

      this.logger.log(
        `Enqueued webhook delivery ${logId} to ${config.url} for event ${event.event}`,
      );
    }

    return { received: true };
  }

  /** A caller-supplied session name, bounded for the log. */
  private logName(name: unknown): string {
    return JSON.stringify(String(name ?? '').slice(0, 80));
  }

  /**
   * Best-effort resolution of a message sender's real phone number (digits only)
   * from a WAHA message payload. Handles the WhatsApp @lid privacy case: when the
   * sender's `from`/`participant` is a `<lid>@lid`, WhatsApp still ships the phone
   * JID alongside it in `_data.key.remoteJidAlt` (DMs) / `participantAlt` (group
   * senders). Prefer those; fall back to `from`/`participant` when they are
   * already a phone JID. Returns null when only a LID is available (no phone JID)
   * or the sender is not a phone (e.g. a group/broadcast id).
   */
  private resolveSenderPhone(payload: any): string | null {
    const key = payload?._data?.key ?? {};
    const candidates = [
      key.participantAlt,
      key.remoteJidAlt,
      payload?.participant,
      payload?.from,
    ];
    for (const jid of candidates) {
      const phone = this.phoneOf(jid);
      if (phone) return phone;
    }
    return null;
  }

  /** <digits>[:device]@(c.us|s.whatsapp.net) → the phone number digits. */
  private phoneOf(jid: unknown): string | null {
    if (typeof jid !== 'string') return null;
    const match = jid.match(/^(\d+)(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/);
    return match ? match[1] : null;
  }

  /**
   * The writer's number from the session's LID store, for a writer WhatsApp
   * addresses only by `<id>@lid`. Null when the store doesn't know the pair or
   * the lookup fails (logged) — never guessed from the LID's digits. Answers
   * are cached per (connection, LID): a known pair is stable, an unknown one is
   * re-asked after a few minutes since a contact sync can teach it.
   */
  private async lookupLidSenderPhone(session: any, payload: any): Promise<string | null> {
    const writer =
      payload?.participant || payload?._data?.key?.participant || payload?.from;
    if (payload?.fromMe || typeof writer !== 'string' || !writer.endsWith('@lid')) {
      return null;
    }

    const cacheKey = `${session.id}:${writer}`;
    const now = Date.now();
    const cached = this.lidPhoneCache.get(cacheKey);
    if (cached && cached.exp > now) return cached.phone;

    let phone: string | null;
    try {
      const worker = await this.workersService.getWorkerForSession(session.id);
      if (!worker) {
        this.logger.warn(`LID sender lookup skipped: no worker for session ${session.id}`);
        return null;
      }
      phone = this.phoneOf(
        await this.wahaService.getLidPhoneChat(
          worker.internalIp,
          worker.apiKeyEnc,
          this.wahaService.resolveSessionName(session.sessionName),
          writer,
        ),
      );
    } catch (error) {
      this.logger.warn(
        `LID sender lookup failed for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (!phone) {
      this.logger.log(`No phone number known for a LID sender on session ${session.id}`);
    }
    if (this.lidPhoneCache.size >= this.LID_PHONE_CACHE_MAX) this.lidPhoneCache.clear();
    this.lidPhoneCache.set(cacheKey, {
      phone,
      exp: now + (phone ? this.LID_PHONE_TTL_MS : this.LID_UNKNOWN_TTL_MS),
    });
    return phone;
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
    statusHistory?: unknown[],
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
    if (needsStatus) {
      updates.status = newStatus;
      // Persist WHY at transition time — WAHA pod logs rotate away in
      // minutes, so this row is the only durable evidence when a session
      // death is investigated later. Cleared on recovery.
      updates.statusReason =
        newStatus === 'working'
          ? null
          : JSON.stringify({
              via: 'waha_event',
              waha_status: wahaStatus,
              at: new Date().toISOString(),
              history: Array.isArray(statusHistory) ? statusHistory.slice(-5) : [],
            });
    }
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
