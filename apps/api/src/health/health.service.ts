import { Inject, Injectable, Logger } from '@nestjs/common';
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
    const wahaSessions_ = await this.wahaService.listSessions(
      worker.internalIp,
      worker.apiKeyEnc,
    );

    const dbSessions = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.workerId, worker.id));

    const wahaSessionMap = new Map(
      wahaSessions_.map((s) => [s.name, s.status]),
    );

    for (const dbSession of dbSessions) {
      const wahaStatus = wahaSessionMap.get(dbSession.sessionName);

      if (!wahaStatus) {
        this.logger.warn(
          `Session "${dbSession.sessionName}" exists in DB but not found on worker ${worker.id}`,
        );
        continue;
      }

      await this.reconcileSessionStatus(worker, dbSession, wahaStatus);
    }
  }

  private async reconcileSessionStatus(
    worker: any,
    dbSession: any,
    wahaStatus: string,
  ): Promise<void> {
    const sessionName = dbSession.sessionName;
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
        this.logger.warn(
          `Session "${sessionName}" is FAILED in WAHA, attempting restart`,
        );
        try {
          await this.wahaService.restartSession(
            worker.internalIp,
            worker.apiKeyEnc,
            sessionName,
          );
          this.logger.log(
            `Restart initiated for failed session "${sessionName}" on worker ${worker.id}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to restart session "${sessionName}": ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.db
            .update(wahaSessions)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(wahaSessions.id, dbSession.id));
        }
        break;

      case 'STOPPED':
        if (dbStatus === 'working' || dbStatus === 'scan_qr') {
          this.logger.warn(
            `Session "${sessionName}" is STOPPED in WAHA but "${dbStatus}" in DB, attempting restart`,
          );
          try {
            await this.wahaService.restartSession(
              worker.internalIp,
              worker.apiKeyEnc,
              sessionName,
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
