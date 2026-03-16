import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, and, ne, sql } from 'drizzle-orm';
import { wahaWorkers, wahaSessions } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { WorkersService } from '../workers/workers.service';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly wahaService: WahaService,
    private readonly workersService: WorkersService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('*/3 * * * *') // Every 3 minutes instead of every minute
  async pollWorkerHealth(): Promise<void> {
    this.logger.log('Starting worker health poll...');

    const activeWorkers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'active'));

    if (activeWorkers.length === 0) {
      this.logger.log('No active workers to check');
      return;
    }

    for (const worker of activeWorkers) {
      try {
        await this.checkWorkerSessions(worker);
        // Reconcile counter after each worker check to fix any drift
        await this.workersService.reconcileWorkerCounter(worker.id);
      } catch (error) {
        this.logger.error(
          `Health check failed for worker ${worker.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log('Worker health poll complete');
  }

  private async checkWorkerSessions(worker: any): Promise<void> {
    let wahaSessions_: Awaited<ReturnType<WahaService['listSessions']>> = [];
    let workerReachable = false;

    try {
      wahaSessions_ = await this.wahaService.listSessions(
        worker.internalIp,
        worker.apiKeyEnc,
      );
      workerReachable = true;
    } catch (error) {
      this.logger.warn(
        `Cannot reach worker ${worker.id} at ${worker.internalIp}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const dbSessions = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.workerId, worker.id));

    if (!workerReachable) {
      // Worker is unreachable (likely still booting). Try to create pending sessions.
      for (const dbSession of dbSessions) {
        if (dbSession.status === 'stopped' || dbSession.status === 'failed') {
          continue;
        }
        await this.tryAutoCreateSession(worker, dbSession);
      }
      return;
    }

    const wahaSessionMap = new Map(
      wahaSessions_.map((s) => [s.name, s.status]),
    );

    // Build set of expected WAHA session names from active DB sessions
    const expectedWahaNames = new Set<string>();

    for (const dbSession of dbSessions) {
      const wahaName = this.wahaService.resolveSessionName(
        dbSession.sessionName,
      );
      const wahaStatus = wahaSessionMap.get(wahaName);

      // Skip stopped/failed sessions — don't auto-create
      if (dbSession.status === 'stopped' || dbSession.status === 'failed') {
        continue;
      }

      expectedWahaNames.add(wahaName);

      if (!wahaStatus) {
        await this.tryAutoCreateSession(worker, dbSession);
        continue;
      }

      await this.reconcileSessionStatus(worker, dbSession, wahaStatus);
    }

    // Clean up orphan WAHA sessions that have no matching active DB record
    for (const [wahaName] of wahaSessionMap) {
      if (!expectedWahaNames.has(wahaName)) {
        this.logger.warn(
          `Orphan WAHA session "${wahaName}" on worker ${worker.id} — stopping`,
        );
        try {
          await this.wahaService.stopSession(
            worker.internalIp,
            worker.apiKeyEnc,
            wahaName,
          );
        } catch {
          // Ignore — session may already be stopped
        }
      }
    }
  }

  private async tryAutoCreateSession(
    worker: any,
    dbSession: any,
  ): Promise<void> {
    // Don't create sessions on workers that are draining or stopped
    if (worker.status === 'draining' || worker.status === 'stopped') {
      this.logger.log(
        `Skipping auto-create on ${worker.status} worker ${worker.id}`,
      );
      return;
    }

    const wahaName = this.wahaService.resolveSessionName(
      dbSession.sessionName,
    );
    this.logger.log(
      `Session "${dbSession.sessionName}" (waha: "${wahaName}") not found on worker ${worker.id} — auto-creating`,
    );

    try {
      const apiUrl = this.configService.get<string>(
        'API_URL',
        'http://localhost:3001',
      );
      const webhookUrl = `${apiUrl}/api/events/waha`;

      await this.wahaService.createSession(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
        webhookUrl,
      );
      await this.wahaService.startSession(
        worker.internalIp,
        worker.apiKeyEnc,
        wahaName,
      );

      await this.db
        .update(wahaSessions)
        .set({ status: 'scan_qr', updatedAt: new Date() })
        .where(eq(wahaSessions.id, dbSession.id));

      this.logger.log(
        `Auto-created session "${dbSession.sessionName}" on worker ${worker.id}`,
      );
    } catch (error) {
      this.logger.warn(
        `Auto-create failed for "${dbSession.sessionName}": ${error instanceof Error ? error.message : String(error)} — will retry next poll`,
      );
    }
  }

  private async reconcileSessionStatus(
    worker: any,
    dbSession: any,
    wahaStatus: string,
  ): Promise<void> {
    const sessionName = dbSession.sessionName;
    const wahaName = this.wahaService.resolveSessionName(sessionName);
    const dbStatus = dbSession.status;

    switch (wahaStatus) {
      case 'WORKING':
        if (dbStatus !== 'working' || !dbSession.phoneNumber) {
          const updates: Record<string, any> = { status: 'working', updatedAt: new Date() };

          // Fetch phone number if we don't have it yet
          if (!dbSession.phoneNumber) {
            try {
              const me = await this.wahaService.getMe(worker.internalIp, worker.apiKeyEnc, wahaName);
              const phone = me?.id?.replace('@c.us', '') || null;
              if (phone) {
                updates.phoneNumber = phone;
                this.logger.log(`Session "${sessionName}" phone: +${phone}`);
              }
            } catch {
              // Non-critical — will retry next poll
            }
          }

          if (dbStatus !== 'working' || updates.phoneNumber) {
            this.logger.log(
              `Session "${sessionName}" is WORKING in WAHA but "${dbStatus}" in DB, updating`,
            );
            await this.db
              .update(wahaSessions)
              .set(updates)
              .where(eq(wahaSessions.id, dbSession.id));
          }
        }
        break;

      case 'SCAN_QR_CODE':
        if (dbStatus !== 'scan_qr') {
          this.logger.log(
            `Session "${sessionName}" is SCAN_QR_CODE in WAHA but "${dbStatus}" in DB, updating to "scan_qr"`,
          );
          await this.db
            .update(wahaSessions)
            .set({ status: 'scan_qr', updatedAt: new Date() })
            .where(eq(wahaSessions.id, dbSession.id));
        }
        break;

      case 'FAILED':
        if (dbStatus === 'failed') {
          // Already tried restarting once; don't loop. User can manually restart.
          break;
        }
        this.logger.warn(
          `Session "${sessionName}" is FAILED in WAHA, marking as failed and attempting logout + restart`,
        );
        // Mark as failed first to prevent restart loops
        await this.db
          .update(wahaSessions)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(wahaSessions.id, dbSession.id));
        try {
          const apiUrl = this.configService.get<string>(
            'API_URL',
            'http://localhost:3001',
          );
          const webhookUrl = `${apiUrl}/api/events/waha`;
          await this.wahaService.resetSession(
            worker.internalIp,
            worker.apiKeyEnc,
            wahaName,
            webhookUrl,
          );
          this.logger.log(
            `Reset initiated for failed session "${sessionName}" on worker ${worker.id}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to restart session "${sessionName}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;

      case 'STOPPED':
        if (dbStatus === 'pending' || dbStatus === 'working' || dbStatus === 'scan_qr') {
          this.logger.warn(
            `Session "${sessionName}" is STOPPED in WAHA but "${dbStatus}" in DB, resetting`,
          );
          try {
            const apiUrl = this.configService.get<string>(
              'API_URL',
              'http://localhost:3001',
            );
            const webhookUrl = `${apiUrl}/api/events/waha`;
            await this.wahaService.resetSession(
              worker.internalIp,
              worker.apiKeyEnc,
              wahaName,
              webhookUrl,
            );
            this.logger.log(
              `Reset initiated for stopped session "${sessionName}" on worker ${worker.id}`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to restart stopped session "${sessionName}": ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        break;

      case 'STARTING':
        // Transitional state, no action needed
        break;

      default:
        this.logger.warn(
          `Session "${sessionName}" has unknown WAHA status: ${wahaStatus}`,
        );
        break;
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOrphanedWahaDatabases(): Promise<void> {
    this.logger.log('Checking for orphaned WAHA databases...');
    try {
      // Get all waha_noweb_* databases
      const dbRows: { datname: string }[] = await this.db.execute(
        sql`SELECT datname FROM pg_database WHERE datname LIKE 'waha_noweb_%'`,
      );

      if (dbRows.length === 0) return;

      // Get all non-stopped session names
      const activeSessions = await this.db
        .select({ sessionName: wahaSessions.sessionName })
        .from(wahaSessions)
        .where(ne(wahaSessions.status, 'stopped'));

      const activeDbNames = new Set(
        activeSessions.map((s: { sessionName: string }) =>
          'waha_noweb_' + s.sessionName,
        ),
      );

      // Also keep the bare defaults
      activeDbNames.add('waha_noweb');
      activeDbNames.add('waha_noweb_default');

      const orphaned = dbRows.filter((r) => !activeDbNames.has(r.datname));

      if (orphaned.length === 0) {
        this.logger.log(`No orphaned WAHA databases (${dbRows.length} total, all active)`);
        return;
      }

      this.logger.warn(
        `Found ${orphaned.length} orphaned WAHA databases, cleaning up...`,
      );

      for (const { datname } of orphaned) {
        try {
          // Must use unsafe() since DROP DATABASE can't be parameterized
          await this.db.execute(
            sql.raw(`DROP DATABASE IF EXISTS "${datname}"`),
          );
          this.logger.log(`Dropped orphaned database: ${datname}`);
        } catch (error) {
          this.logger.error(
            `Failed to drop database ${datname}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      this.logger.log(`Cleanup complete: dropped ${orphaned.length} orphaned databases`);
    } catch (error) {
      this.logger.error(
        `Orphaned database cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkScaling(): Promise<void> {
    this.logger.log('Running scaling check...');
    try {
      await this.workersService.checkScaling();
      this.logger.log('Scaling check complete');
    } catch (error) {
      this.logger.error(
        `Scaling check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
