import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  UseGuards,
  Logger,
  Query,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, ne, sql, and, inArray } from 'drizzle-orm';
import { wahaWorkers, wahaSessions } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { EventMetricsService } from '../events/event-metrics.service';
import { EVENT_RANGES, EventVolume, isEventRange } from '../events/event-metrics';
import { FAILED_JOBS_KEPT } from '../events/events.module';
import { WorkersService } from './workers.service';
import { GatewayResources, GatewayResourcesService } from './gateway-resources.service';

@Controller('infrastructure')
@UseGuards(AuthGuard, AdminGuard)
export class WorkersController {
  private readonly logger = new Logger(WorkersController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @InjectQueue('webhook-delivery') private readonly webhookQueue: Queue,
    private readonly workersService: WorkersService,
    private readonly gatewayResources: GatewayResourcesService,
    private readonly eventMetrics: EventMetricsService,
  ) {}

  /**
   * Events received and webhook deliveries over time, from the per-minute
   * counters in Redis: 60 one-minute buckets for `1h` (the default), 288
   * five-minute buckets for `24h`, 168 hourly buckets for `7d`.
   */
  @Get('events')
  async getEventVolume(@Query('range') range?: string): Promise<EventVolume> {
    const selected = range ?? '1h';
    if (!isEventRange(selected)) {
      throw new BadRequestException(`range must be one of ${Object.keys(EVENT_RANGES).join(', ')}`);
    }
    return this.eventMetrics.read(selected);
  }

  @Get()
  async getInfrastructureStatus(@CurrentUser() user: { sub: string }) {
    // Get all non-stopped workers
    const workers = await this.db
      .select()
      .from(wahaWorkers)
      .where(ne(wahaWorkers.status, 'stopped'));

    // Get session counts per worker for this user
    const userSessions = await this.db
      .select({
        workerId: wahaSessions.workerId,
        status: wahaSessions.status,
        count: sql`count(*)`,
      })
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          ne(wahaSessions.status, 'stopped'),
        ),
      )
      .groupBy(wahaSessions.workerId, wahaSessions.status);

    // Per-worker session counts split into live (working/scan_qr/pending —
    // what counts toward capacity) and failed (present on the pod but idle, not
    // counted). `stopped` is soft-deleted and excluded entirely.
    const allSessions = await this.db
      .select({
        workerId: wahaSessions.workerId,
        status: wahaSessions.status,
        count: sql`count(*)`,
      })
      .from(wahaSessions)
      .where(ne(wahaSessions.status, 'stopped'))
      .groupBy(wahaSessions.workerId, wahaSessions.status);

    const liveMap: Record<string, number> = {};
    const failedMap: Record<string, number> = {};
    for (const row of allSessions) {
      if (!row.workerId) continue;
      const n = Number(row.count);
      if (row.status === 'failed') {
        failedMap[row.workerId] = (failedMap[row.workerId] ?? 0) + n;
      } else {
        liveMap[row.workerId] = (liveMap[row.workerId] ?? 0) + n;
      }
    }

    // CPU, memory and connection utilization of each active gateway box
    // (cached ~60 s; a failing source leaves its part null, never fails this).
    let resources = new Map<string, GatewayResources>();
    try {
      resources = await this.gatewayResources.resourcesFor(
        workers.filter((w: any) => w.kind === 'gateway' && w.status === 'active'),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to read gateway resources: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Build per-worker info. `currentSessions` is the capacity-driving live count
    // (matches the reconciled counter); `failedSessions` is shown separately.
    // `resources` is null for WAHA pods and gateways that aren't active.
    const workerInfo = workers.map((w: any) => {
      const live = liveMap[w.id] ?? 0;
      return {
        id: w.id,
        podName: w.podName,
        status: w.status,
        kind: w.kind ?? 'waha',
        currentSessions: live,
        failedSessions: failedMap[w.id] ?? 0,
        maxSessions: w.maxSessions,
        utilization: w.maxSessions > 0
          ? Math.round((live / w.maxSessions) * 100)
          : 0,
        resources: resources.get(w.id) ?? null,
      };
    });

    // Build per-user session summary
    const userSessionsByStatus: Record<string, number> = {};
    let userTotal = 0;
    for (const row of userSessions) {
      const count = Number(row.count);
      userSessionsByStatus[row.status] = (userSessionsByStatus[row.status] ?? 0) + count;
      userTotal += count;
    }

    const totalCapacity = workerInfo.reduce((sum: number, w: any) => sum + w.maxSessions, 0);
    const totalUsed = workerInfo.reduce((sum: number, w: any) => sum + w.currentSessions, 0);
    const totalFailed = workerInfo.reduce((sum: number, w: any) => sum + w.failedSessions, 0);

    // Webhook delivery queue stats (BullMQ → Redis). Counts only — cheap.
    // `failed` is the failed jobs BullMQ keeps, at most `failedKept`: it stops
    // there, so `failedLast24h` (from the event counters; null when they can't
    // be read) is the number that says how many deliveries were given up on.
    const [counts, failedLast24h] = await Promise.all([
      this.webhookQueue
        .getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
        .catch((err: unknown) => {
          this.logger.warn(
            `Failed to read webhook queue counts: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }),
      this.eventMetrics.countRecent('failed', 24 * 60),
    ]);
    const webhookQueue = {
      waiting: counts?.waiting ?? 0,
      active: counts?.active ?? 0,
      delayed: counts?.delayed ?? 0,
      failed: counts?.failed ?? 0,
      completed: counts?.completed ?? 0,
      reachable: counts !== null,
      failedKept: FAILED_JOBS_KEPT,
      failedLast24h,
    };

    return {
      workers: workerInfo,
      summary: {
        totalWorkers: workerInfo.filter((w: any) => w.status === 'active').length,
        drainingWorkers: workerInfo.filter((w: any) => w.status === 'draining').length,
        totalCapacity,
        totalUsed,
        totalFailed,
        remainingSlots: totalCapacity - totalUsed,
        utilization: totalCapacity > 0
          ? Math.round((totalUsed / totalCapacity) * 100)
          : 0,
      },
      userSessions: {
        total: userTotal,
        byStatus: userSessionsByStatus,
      },
      // Non-null while worker scale-ups keep failing (e.g. the cloud refuses
      // new servers): new connections can't be placed once capacity runs out.
      scaleUpFailure: this.workersService.getScaleUpFailure(),
      webhookQueue,
      timestamp: new Date().toISOString(),
    };
  }
}
