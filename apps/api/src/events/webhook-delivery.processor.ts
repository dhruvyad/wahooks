import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { eq } from 'drizzle-orm';
import { webhookEventLogs } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

interface WebhookJob {
  webhookConfigId: string;
  url: string;
  signingSecret: string;
  eventType: string;
  payload: unknown;
  sessionId: string;
  logId: string;
}

@Processor('webhook-delivery')
export class WebhookDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliveryProcessor.name);

  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {
    super();
  }

  async process(job: Job<WebhookJob>): Promise<void> {
    const { url, signingSecret, eventType, payload, logId } = job.data;
    const body = JSON.stringify(payload);

    // Generate HMAC-SHA256 signature
    const signature = createHmac('sha256', signingSecret)
      .update(body)
      .digest('hex');

    const timestamp = Date.now().toString();
    const signatureHeader = `sha256=${signature}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const response: FetchResponse = await fetch(url, {
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

      // Mark as delivered
      await this.db
        .update(webhookEventLogs)
        .set({
          status: 'delivered',
          attempts: job.attemptsMade + 1,
          deliveredAt: new Date(),
        })
        .where(eq(webhookEventLogs.id, logId));

      this.logger.log(`Delivered webhook ${logId} to ${url}`);
    } catch (error) {
      // Update attempt count
      await this.db
        .update(webhookEventLogs)
        .set({
          attempts: job.attemptsMade + 1,
          status:
            job.attemptsMade + 1 >= (job.opts.attempts ?? 5)
              ? 'failed'
              : 'pending',
        })
        .where(eq(webhookEventLogs.id, logId));

      this.logger.error(
        `Failed to deliver webhook ${logId} to ${url} (attempt ${job.attemptsMade + 1}): ${error instanceof Error ? error.message : String(error)}`,
      );

      throw error; // Re-throw so BullMQ retries
    }
  }
}
