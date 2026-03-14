import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { wahaSessions, usageRecords } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  /**
   * Record hourly usage for active sessions (for analytics, not billing).
   * With prepaid slots, this is purely for tracking/reporting.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async recordHourlyUsage(): Promise<void> {
    this.logger.log('Recording hourly usage...');

    const now = new Date();
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
    const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);

    const activeSessions = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.status, 'working'));

    if (activeSessions.length === 0) {
      this.logger.log('No active sessions to record');
      return;
    }

    for (const session of activeSessions) {
      try {
        await this.db.insert(usageRecords).values({
          sessionId: session.id,
          periodStart,
          periodEnd,
          connectionHours: '1.000000',
          reportedToStripe: true, // No Stripe reporting in prepaid model
        });
      } catch (error) {
        this.logger.error(
          `Failed to record usage for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(`Recorded usage for ${activeSessions.length} active sessions`);
  }

  /**
   * Get usage summary for a user.
   */
  async getUserUsageSummary(userId: string): Promise<{
    totalHours: number;
    activeConnections: number;
  }> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const sessions = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.userId, userId));

    const sessionIds = sessions.map((s: any) => s.id);
    const activeConnections = sessions.filter((s: any) => s.status === 'working').length;

    if (sessionIds.length === 0) {
      return { totalHours: 0, activeConnections: 0 };
    }

    let totalHours = 0;
    for (const sid of sessionIds) {
      const records = await this.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.sessionId, sid));

      for (const record of records) {
        const periodStart = new Date(record.periodStart);
        if (periodStart >= monthStart) {
          totalHours += parseFloat(record.connectionHours);
        }
      }
    }

    return {
      totalHours: Math.round(totalHours * 100) / 100,
      activeConnections,
    };
  }
}
