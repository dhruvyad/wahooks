import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { eq, ne, sql, and } from 'drizzle-orm';
import { wahaWorkers, wahaSessions } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';

@Controller('infrastructure')
@UseGuards(AuthGuard)
export class WorkersController {
  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

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

    // Get total session counts per worker (all users)
    const allSessions = await this.db
      .select({
        workerId: wahaSessions.workerId,
        count: sql`count(*)`,
      })
      .from(wahaSessions)
      .where(ne(wahaSessions.status, 'stopped'))
      .groupBy(wahaSessions.workerId);

    const totalSessionMap: Record<string, number> = {};
    for (const row of allSessions) {
      if (row.workerId) {
        totalSessionMap[row.workerId] = Number(row.count);
      }
    }

    // Build per-worker info
    const workerInfo = workers.map((w: any) => ({
      id: w.id,
      podName: w.podName,
      status: w.status,
      currentSessions: w.currentSessions,
      maxSessions: w.maxSessions,
      utilization: w.maxSessions > 0
        ? Math.round((w.currentSessions / w.maxSessions) * 100)
        : 0,
      actualSessions: totalSessionMap[w.id] ?? 0,
    }));

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

    return {
      workers: workerInfo,
      summary: {
        totalWorkers: workerInfo.filter((w: any) => w.status === 'active').length,
        drainingWorkers: workerInfo.filter((w: any) => w.status === 'draining').length,
        totalCapacity,
        totalUsed,
        remainingSlots: totalCapacity - totalUsed,
        utilization: totalCapacity > 0
          ? Math.round((totalUsed / totalCapacity) * 100)
          : 0,
      },
      userSessions: {
        total: userTotal,
        byStatus: userSessionsByStatus,
      },
    };
  }
}
