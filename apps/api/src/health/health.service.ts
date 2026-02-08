import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, and } from 'drizzle-orm';
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

  @Cron(CronExpression.EVERY_MINUTE)
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

    for (const dbSession of dbSessions) {
      // Look up by resolved WAHA name (e.g. 'default' for Core)
      const wahaName = this.wahaService.resolveSessionName(
        dbSession.sessionName,
      );
      const wahaStatus = wahaSessionMap.get(wahaName);

      if (!wahaStatus) {
        if (dbSession.status === 'stopped' || dbSession.status === 'failed') {
          continue;
        }
        await this.tryAutoCreateSession(worker, dbSession);
        continue;
      }

      await this.reconcileSessionStatus(worker, dbSession, wahaStatus);
    }
  }

  private async tryAutoCreateSession(
    worker: any,
    dbSession: any,
  ): Promise<void> {
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
        if (dbStatus !== 'working') {
          this.logger.log(
            `Session "${sessionName}" is WORKING in WAHA but "${dbStatus}" in DB, updating to "working"`,
          );
          await this.db
            .update(wahaSessions)
            .set({ status: 'working', updatedAt: new Date() })
            .where(eq(wahaSessions.id, dbSession.id));
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
          `Session "${sessionName}" is FAILED in WAHA, marking as failed and attempting one restart`,
        );
        // Mark as failed first to prevent restart loops
        await this.db
          .update(wahaSessions)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(wahaSessions.id, dbSession.id));
        try {
          await this.wahaService.restartSession(
            worker.internalIp,
            worker.apiKeyEnc,
            wahaName,
          );
          this.logger.log(
            `Restart initiated for failed session "${sessionName}" on worker ${worker.id}`,
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
            `Session "${sessionName}" is STOPPED in WAHA but "${dbStatus}" in DB, attempting restart`,
          );
          try {
            await this.wahaService.restartSession(
              worker.internalIp,
              worker.apiKeyEnc,
              wahaName,
            );
            this.logger.log(
              `Restart initiated for stopped session "${sessionName}" on worker ${worker.id}`,
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
