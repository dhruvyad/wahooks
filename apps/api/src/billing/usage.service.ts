import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { wahaSessions, usageRecords, users } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly stripeService: StripeService,
  ) {}

  // Run every hour — record connection-hours for active sessions
  @Cron(CronExpression.EVERY_HOUR)
  async recordHourlyUsage(): Promise<void> {
    this.logger.log('Recording hourly usage...');

    const now = new Date();
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
    const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000); // 1 hour before

    // Find all sessions that were 'working' during this period
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
          connectionHours: '1.000000', // 1 full hour
          reportedToStripe: false,
        });
      } catch (error) {
        this.logger.error(
          `Failed to record usage for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(`Recorded usage for ${activeSessions.length} active sessions`);
  }

  // Run every hour (offset by 5 min) — report unreported usage to Stripe
  @Cron('5 * * * *') // At minute 5 of every hour
  async reportUsageToStripe(): Promise<void> {
    this.logger.log('Reporting usage to Stripe...');

    // Get unreported usage records grouped by session
    const unreported = await this.db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.reportedToStripe, false));

    if (unreported.length === 0) {
      this.logger.log('No unreported usage to send to Stripe');
      return;
    }

    // Group by session's user to find their Stripe subscription
    const sessionIds = [...new Set(unreported.map((r: any) => r.sessionId))];

    for (const sessionId of sessionIds as string[]) {
      try {
        const sessionRecords = unreported.filter((r: any) => r.sessionId === sessionId);
        const totalHours = sessionRecords.reduce(
          (sum: number, r: any) => sum + parseFloat(r.connectionHours),
          0,
        );

        // Look up the session's user
        const [session] = await this.db
          .select()
          .from(wahaSessions)
          .where(eq(wahaSessions.id, sessionId));

        if (!session) continue;

        const [user] = await this.db
          .select()
          .from(users)
          .where(eq(users.id, session.userId));

        if (!user?.stripeCustomerId) {
          this.logger.warn(`User ${session.userId} has no Stripe customer ID, skipping usage report`);
          continue;
        }

        // Find active subscription
        const subs = await this.stripeService.getCustomerSubscriptions(user.stripeCustomerId);
        const activeSub = subs.find((s) => s.status === 'active' || s.status === 'trialing');

        if (!activeSub || !activeSub.items.data[0]) {
          this.logger.warn(`No active subscription for user ${session.userId}, skipping usage report`);
          continue;
        }

        // Report usage
        await this.stripeService.reportUsage(
          activeSub.items.data[0].id,
          totalHours,
          Math.floor(Date.now() / 1000),
        );

        // Mark as reported
        for (const record of sessionRecords) {
          await this.db
            .update(usageRecords)
            .set({ reportedToStripe: true })
            .where(eq(usageRecords.id, record.id));
        }

        this.logger.log(
          `Reported ${totalHours} connection-hours for session ${sessionId} to Stripe`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to report usage for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Get usage summary for a user (total connection-hours this month)
  async getUserUsageSummary(userId: string): Promise<{ totalHours: number; estimatedCost: number; activeConnections: number }> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get all sessions for the user
    const sessions = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.userId, userId));

    const sessionIds = sessions.map((s: any) => s.id);
    const activeConnections = sessions.filter((s: any) => s.status === 'working').length;

    if (sessionIds.length === 0) {
      return { totalHours: 0, estimatedCost: 0, activeConnections: 0 };
    }

    // Sum usage records for this month across all sessions
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

    const PRICE_PER_CONNECTION_HOUR = 0.25 / 720;
    const estimatedCost = totalHours * PRICE_PER_CONNECTION_HOUR;

    return {
      totalHours: Math.round(totalHours * 100) / 100,
      estimatedCost: Math.round(estimatedCost * 100) / 100,
      activeConnections,
    };
  }
}
