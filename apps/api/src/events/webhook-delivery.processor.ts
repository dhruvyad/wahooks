import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { webhookConfigs, webhookEventLogs } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { EventMetricsService } from './event-metrics.service';

interface WebhookJob {
  webhookConfigId: string;
  url: string;
  signingSecret: string;
  eventType: string;
  payload: unknown;
  sessionId: string;
  logId: string;
  /** When the event arrived (the log row's created_at). Absent on jobs queued before this field existed. */
  createdAt?: string;
}

/** A webhook whose every delivery failed (all retries) for this long is paused, as Svix and Stripe do. */
export const PAUSE_FAILING_WEBHOOK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a success is trusted to have cleared failing_since, so a busy healthy webhook costs no writes. */
const HEALTHY_RECHECK_MS = 10 * 60 * 1000;

// Concurrency: each worker handles up to 20 jobs in flight. Webhook delivery is
// I/O-bound (a single slow customer endpoint shouldn't block the whole queue).
@Processor('webhook-delivery', { concurrency: 20 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);
  /** Webhook id → until when it's known to have no failing_since (this pod cleared it or saw it clear). */
  private readonly knownHealthy = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly eventMetrics: EventMetricsService,
  ) {
    super();
  }

  async process(job: Job<WebhookJob>): Promise<void> {
    const { url, signingSecret, eventType, payload, logId } = job.data;
    const body = JSON.stringify(payload);

    // Generate HMAC-SHA256 signature over "timestamp.body" to prevent replay attacks
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${timestamp}.${body}`;
    const signature = createHmac('sha256', signingSecret)
      .update(signedPayload)
      .digest('hex');

    const signatureHeader = `sha256=${signature}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WAHooks-Signature': signatureHeader,
          'X-WAHooks-Timestamp': timestamp,
          'X-WAHooks-Event': eventType,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const respBody = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${respBody.substring(0, 500)}`,
        );
      }

      await this.recordAttempt(job, {
        status: 'delivered',
        attempts: job.attemptsMade + 1,
        deliveredAt: new Date(),
      });
      // Counters never reject and aren't waited on (event volume graphs).
      void this.eventMetrics.countDelivery('delivered');
      await this.markHealthy(job.data.webhookConfigId);

      this.logger.log(`Delivered webhook ${logId} to ${url}`);
    } catch (error) {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 5);
      void this.eventMetrics.countDelivery(final ? 'failed' : 'retried');
      await this.recordAttempt(job, {
        attempts: job.attemptsMade + 1,
        status: final ? 'failed' : 'pending',
      });
      if (final) await this.markFailing(job.data.webhookConfigId, url);

      this.logger.error(
        `Failed to deliver webhook ${logId} to ${url} (attempt ${job.attemptsMade + 1}): ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error; // Re-throw so BullMQ retries
    }
  }

  /** A delivery got through: the webhook isn't failing (any more). */
  private async markHealthy(webhookConfigId: string): Promise<void> {
    const now = Date.now();
    if ((this.knownHealthy.get(webhookConfigId) ?? 0) > now) return;
    try {
      await this.db
        .update(webhookConfigs)
        .set({ failingSince: null })
        .where(and(eq(webhookConfigs.id, webhookConfigId), isNotNull(webhookConfigs.failingSince)));
      if (this.knownHealthy.size >= 10_000) this.knownHealthy.clear();
      this.knownHealthy.set(webhookConfigId, now + HEALTHY_RECHECK_MS);
    } catch (error) {
      this.logger.warn(
        `Couldn't clear failing_since on webhook ${webhookConfigId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A delivery failed every retry. Starts the webhook's failing run if this is its first such delivery,
   * and pauses the webhook once the run has lasted PAUSE_FAILING_WEBHOOK_AFTER_MS without one success.
   */
  private async markFailing(webhookConfigId: string, url: string): Promise<void> {
    this.knownHealthy.delete(webhookConfigId);
    try {
      const [row] = await this.db
        .update(webhookConfigs)
        .set({ failingSince: sql`coalesce(${webhookConfigs.failingSince}, now())` })
        .where(eq(webhookConfigs.id, webhookConfigId))
        .returning({ failingSince: webhookConfigs.failingSince, active: webhookConfigs.active });
      if (!row?.active || !row.failingSince) return;
      const failingFor = Date.now() - new Date(row.failingSince).getTime();
      if (failingFor < PAUSE_FAILING_WEBHOOK_AFTER_MS) return;
      const paused = await this.db
        .update(webhookConfigs)
        .set({ active: false, pausedAt: new Date(), pausedReason: 'failing', updatedAt: new Date() })
        .where(and(eq(webhookConfigs.id, webhookConfigId), eq(webhookConfigs.active, true)))
        .returning({ id: webhookConfigs.id });
      if (paused.length > 0) {
        this.logger.warn(
          `Paused webhook ${webhookConfigId} (${url}): every delivery has failed for ${Math.floor(failingFor / 3_600_000)} h`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Couldn't record a failing delivery on webhook ${webhookConfigId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Writes the delivery's log row: inserted when the first attempt ends (a delivery that succeeds
   * first time costs one write), updated by later attempts. The id was fixed when the event was
   * queued, so every attempt lands on the same row.
   */
  private async recordAttempt(
    job: Job<WebhookJob>,
    result: { status: 'pending' | 'delivered' | 'failed'; attempts: number; deliveredAt?: Date },
  ): Promise<void> {
    const { webhookConfigId, eventType, payload, logId, createdAt } = job.data;
    const set: Record<string, unknown> = { status: result.status, attempts: result.attempts };
    if (result.deliveredAt) set.deliveredAt = result.deliveredAt;
    try {
      await this.db
        .insert(webhookEventLogs)
        .values({
          id: logId,
          webhookConfigId,
          eventType,
          payload,
          status: result.status,
          attempts: result.attempts,
          deliveredAt: result.deliveredAt ?? null,
          createdAt: new Date(createdAt ?? job.timestamp ?? Date.now()),
        })
        .onConflictDoUpdate({ target: webhookEventLogs.id, set });
    } catch (error) {
      // The webhook was deleted while this delivery was queued; its logs went with it.
      if ((error as { code?: string })?.code === '23503') return;
      throw error;
    }
  }
}
