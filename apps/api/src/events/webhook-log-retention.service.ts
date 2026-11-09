import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DRIZZLE_TOKEN } from '../database/database.module';

/** Delivery log rows kept per webhook. The dashboard and GET /webhooks/:id/logs show the last 100. */
export const WEBHOOK_LOG_KEEP = 100;

/**
 * Keeps webhook_event_logs to the newest WEBHOOK_LOG_KEEP rows per webhook.
 *
 * Without a limit the table grew ~29 MB per connection per month (every event's full payload, kept
 * forever) and was the largest thing in the database. Webhooks that received events since the last
 * run are trimmed every 5 minutes; a daily sweep catches the rest (test sends, rows written before a
 * restart). A pending row from the last hour is never deleted: its delivery may still be retrying.
 */
@Injectable()
export class WebhookLogRetentionService {
  private readonly logger = new Logger(WebhookLogRetentionService.name);
  private touched = new Set<string>();

  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  /** Note that a webhook got a new delivery, so the next trim looks at it. */
  touch(webhookConfigId: string): void {
    this.touched.add(webhookConfigId);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async trimTouched(): Promise<void> {
    if (this.touched.size === 0) return;
    const ids = [...this.touched];
    this.touched = new Set();
    let deleted = 0;
    for (const id of ids) deleted += await this.trim(id);
    if (deleted > 0) {
      this.logger.log(`Trimmed ${deleted} old delivery log rows across ${ids.length} webhooks`);
    }
  }

  @Cron('17 3 * * *')
  async trimAll(): Promise<void> {
    try {
      const rows: { id: string }[] = await this.db.execute(sql`
        SELECT webhook_config_id AS id FROM webhook_event_logs
        GROUP BY webhook_config_id HAVING count(*) > ${WEBHOOK_LOG_KEEP}`);
      let deleted = 0;
      for (const { id } of rows) deleted += await this.trim(id);
      this.logger.log(`Daily delivery log sweep: ${deleted} rows trimmed across ${rows.length} webhooks`);
    } catch (error) {
      this.logger.error(
        `Daily delivery log sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Deletes one webhook's rows past the newest WEBHOOK_LOG_KEEP. Returns the number deleted. */
  async trim(webhookConfigId: string): Promise<number> {
    try {
      const res = await this.db.execute(sql`
        DELETE FROM webhook_event_logs
        WHERE id IN (
          SELECT id FROM webhook_event_logs
          WHERE webhook_config_id = ${webhookConfigId}
          ORDER BY created_at DESC
          OFFSET ${WEBHOOK_LOG_KEEP}
        )
        AND (status <> 'pending' OR created_at < now() - interval '1 hour')`);
      return typeof res?.count === 'number' ? res.count : 0;
    } catch (error) {
      this.logger.warn(
        `Trimming delivery logs for webhook ${webhookConfigId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}
