import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { webhookEventLogs } from '@wahooks/db';
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

// Concurrency: each worker handles up to 20 jobs in flight. Webhook delivery is
// I/O-bound (a single slow customer endpoint shouldn't block the whole queue).
@Processor('webhook-delivery', { concurrency: 20 })
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

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

      this.logger.log(`Delivered webhook ${logId} to ${url}`);
    } catch (error) {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 5);
      void this.eventMetrics.countDelivery(final ? 'failed' : 'retried');
      await this.recordAttempt(job, {
        attempts: job.attemptsMade + 1,
        status: final ? 'failed' : 'pending',
      });

      this.logger.error(
        `Failed to deliver webhook ${logId} to ${url} (attempt ${job.attemptsMade + 1}): ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error; // Re-throw so BullMQ retries
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
