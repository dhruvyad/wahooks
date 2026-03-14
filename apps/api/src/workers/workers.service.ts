import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, lt, and, sql, ne } from 'drizzle-orm';
import { wahaWorkers, wahaSessions } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import {
  ORCHESTRATOR_TOKEN,
  ContainerOrchestrator,
} from '../orchestration/orchestrator.interface';

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);
  private readonly maxSessionsPerWorker: number;
  private provisioningInProgress = false;

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @Inject(ORCHESTRATOR_TOKEN)
    private readonly orchestrator: ContainerOrchestrator,
    private readonly configService: ConfigService,
  ) {
    this.maxSessionsPerWorker = Number(
      this.configService.get('WAHA_MAX_SESSIONS', '1'),
    );
  }

  /**
   * Find a worker with available capacity, or provision a new one.
   */
  async findOrProvisionWorker(): Promise<{
    id: string;
    internalIp: string;
    apiKey: string;
  }> {
    // Query active workers with remaining capacity, least-loaded first
    const available = await this.db
      .select()
      .from(wahaWorkers)
      .where(
        and(
          eq(wahaWorkers.status, 'active'),
          lt(wahaWorkers.currentSessions, wahaWorkers.maxSessions),
        ),
      )
      .orderBy(wahaWorkers.currentSessions)
      .limit(1);

    if (available.length > 0) {
      const worker = available[0];
      this.logger.log(
        `Found available worker ${worker.id} (${worker.currentSessions}/${worker.maxSessions} sessions)`,
      );
      return {
        id: worker.id,
        internalIp: worker.internalIp,
        apiKey: worker.apiKeyEnc,
      };
    }

    // Prevent concurrent provisioning — if already provisioning, throw
    // so the caller can return the connection as 'pending'
    if (this.provisioningInProgress) {
      throw new Error('Worker provisioning already in progress');
    }

    // No available workers — provision a new one
    this.provisioningInProgress = true;
    this.logger.log('No available workers found, provisioning new worker...');

    try {
      const result = await this.orchestrator.provisionWorker();

      const [inserted] = await this.db
        .insert(wahaWorkers)
        .values({
          podName: result.podName,
          internalIp: result.internalIp,
          apiKeyEnc: result.apiKey,
          status: 'active',
          maxSessions: this.maxSessionsPerWorker,
        })
        .returning();

      this.logger.log(
        `Provisioned new worker ${inserted.id} at ${inserted.internalIp}`,
      );

      return {
        id: inserted.id,
        internalIp: inserted.internalIp,
        apiKey: inserted.apiKeyEnc,
      };
    } finally {
      this.provisioningInProgress = false;
    }
  }

  /**
   * Assign a session to a worker (increment current_sessions).
   */
  async assignSession(workerId: string, sessionId: string): Promise<void> {
    await this.db.transaction(async (tx: any) => {
      await tx
        .update(wahaSessions)
        .set({ workerId })
        .where(eq(wahaSessions.id, sessionId));

      await tx
        .update(wahaWorkers)
        .set({
          currentSessions: sql`${wahaWorkers.currentSessions} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(wahaWorkers.id, workerId));
    });

    this.logger.log(`Assigned session ${sessionId} to worker ${workerId}`);
  }

  /**
   * Unassign a session from a worker (decrement current_sessions).
   */
  async unassignSession(workerId: string, sessionId: string): Promise<void> {
    await this.db.transaction(async (tx: any) => {
      await tx
        .update(wahaSessions)
        .set({ workerId: null })
        .where(eq(wahaSessions.id, sessionId));

      await tx
        .update(wahaWorkers)
        .set({
          currentSessions: sql`GREATEST(${wahaWorkers.currentSessions} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(wahaWorkers.id, workerId));
    });

    this.logger.log(`Unassigned session ${sessionId} from worker ${workerId}`);
  }

  /**
   * Reconcile a worker's currentSessions counter with actual DB records.
   * Fixes drift caused by failed creates, partial deletes, etc.
   */
  async reconcileWorkerCounter(workerId: string): Promise<void> {
    const actualCount = await this.db
      .select({ count: sql`count(*)` })
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.workerId, workerId),
          ne(wahaSessions.status, 'stopped'),
        ),
      );

    const count = Number(actualCount[0]?.count ?? 0);

    await this.db
      .update(wahaWorkers)
      .set({ currentSessions: count, updatedAt: new Date() })
      .where(eq(wahaWorkers.id, workerId));
  }

  /**
   * Get worker details by ID.
   */
  async getWorker(workerId: string): Promise<{
    id: string;
    podName: string;
    internalIp: string;
    apiKeyEnc: string;
    status: string;
    currentSessions: number;
    maxSessions: number;
  } | null> {
    const rows = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.id, workerId))
      .limit(1);

    if (rows.length === 0) return null;

    const w = rows[0];
    return {
      id: w.id,
      podName: w.podName,
      internalIp: w.internalIp,
      apiKeyEnc: w.apiKeyEnc,
      status: w.status,
      currentSessions: w.currentSessions,
      maxSessions: w.maxSessions,
    };
  }

  /**
   * Get the worker assigned to a specific session.
   */
  async getWorkerForSession(sessionId: string): Promise<{
    id: string;
    internalIp: string;
    apiKeyEnc: string;
  } | null> {
    const rows = await this.db
      .select()
      .from(wahaSessions)
      .where(eq(wahaSessions.id, sessionId))
      .limit(1);

    if (rows.length === 0 || !rows[0].workerId) return null;

    const worker = await this.getWorker(rows[0].workerId);
    if (!worker) return null;

    return {
      id: worker.id,
      internalIp: worker.internalIp,
      apiKeyEnc: worker.apiKeyEnc,
    };
  }

  /**
   * List all active workers.
   */
  async listWorkers(): Promise<
    Array<{
      id: string;
      status: string;
      currentSessions: number;
      maxSessions: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'active'));

    return rows.map((w: any) => ({
      id: w.id,
      status: w.status,
      currentSessions: w.currentSessions,
      maxSessions: w.maxSessions,
    }));
  }

  /**
   * Check scaling needs. Called by health service every 5 minutes.
   *
   * Scale up: when all workers are full AND pending sessions exist
   * Scale down: when all workers are below 30% AND there are >1 workers
   * Drain cleanup: when draining workers have 0 sessions, destroy them
   */
  async checkScaling(): Promise<void> {
    // 1. Reconcile all active worker counters with actual DB records
    const activeWorkers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'active'));

    for (const worker of activeWorkers) {
      await this.reconcileWorkerCounter(worker.id);
    }

    // Re-fetch after reconciliation
    const workers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'active'));

    // 2. Handle draining workers that are now empty
    const drainingWorkers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'draining'));

    for (const worker of drainingWorkers) {
      // Reconcile counter for draining workers too
      await this.reconcileWorkerCounter(worker.id);
      const updated = await this.getWorker(worker.id);

      if (updated && updated.currentSessions === 0) {
        this.logger.log(
          `Draining worker ${worker.id} (${updated.podName}) has 0 sessions, destroying...`,
        );
        await this.destroyWorker(worker.id);
      }
    }

    if (workers.length === 0) {
      this.logger.log('No active workers found, nothing to scale');
      return;
    }

    // 3. Scale up: only if ALL workers are full AND unassigned pending sessions exist
    const hasAvailableCapacity = workers.some(
      (w: any) => w.currentSessions < w.maxSessions,
    );

    if (!hasAvailableCapacity) {
      const pendingSessions = await this.db
        .select()
        .from(wahaSessions)
        .where(
          and(
            eq(wahaSessions.status, 'pending'),
            sql`${wahaSessions.workerId} IS NULL`,
          ),
        );

      if (pendingSessions.length > 0 && !this.provisioningInProgress) {
        this.logger.log(
          `All ${workers.length} workers at capacity, ${pendingSessions.length} pending — provisioning`,
        );
        try {
          await this.findOrProvisionWorker();
        } catch (error) {
          this.logger.warn(
            `Scale-up failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
    }

    // 4. Scale down: if ALL workers below 30% and >1 workers
    if (workers.length <= 1) return;

    const allUnderThreshold = workers.every(
      (w: any) => w.currentSessions / w.maxSessions < 0.3,
    );

    if (allUnderThreshold) {
      // Find highest-ordinal worker to drain
      const drainTarget = [...workers].sort((a: any, b: any) => {
        const ordA = parseInt(a.podName?.match(/-(\d+)$/)?.[1] ?? '0', 10);
        const ordB = parseInt(b.podName?.match(/-(\d+)$/)?.[1] ?? '0', 10);
        return ordB - ordA;
      })[0];

      this.logger.log(
        `All workers below 30%, draining ${drainTarget.podName} (${drainTarget.currentSessions} sessions)`,
      );

      // If it has sessions, stop them first (they're all scan_qr/pending anyway)
      if (drainTarget.currentSessions > 0) {
        await this.db
          .update(wahaSessions)
          .set({ status: 'stopped', workerId: null })
          .where(
            and(
              eq(wahaSessions.workerId, drainTarget.id),
              ne(wahaSessions.status, 'stopped'),
            ),
          );
        await this.reconcileWorkerCounter(drainTarget.id);
      }

      await this.drainWorker(drainTarget.id);
    }
  }

  /**
   * Drain a worker (mark as draining, no new sessions will be assigned).
   */
  async drainWorker(workerId: string): Promise<void> {
    await this.db
      .update(wahaWorkers)
      .set({ status: 'draining', updatedAt: new Date() })
      .where(eq(wahaWorkers.id, workerId));

    this.logger.log(`Worker ${workerId} marked as draining`);
  }

  /**
   * Destroy a worker (only if drained, current_sessions === 0).
   */
  async destroyWorker(workerId: string): Promise<void> {
    const worker = await this.getWorker(workerId);

    if (!worker) {
      this.logger.warn(`Cannot destroy worker ${workerId}: not found`);
      return;
    }

    if (worker.currentSessions > 0) {
      this.logger.warn(
        `Cannot destroy worker ${workerId}: still has ${worker.currentSessions} active sessions`,
      );
      return;
    }

    if (worker.podName) {
      try {
        await this.orchestrator.destroyWorker(worker.podName);
        this.logger.log(
          `Destroyed worker pod ${worker.podName} for worker ${workerId}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to destroy pod ${worker.podName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.db
      .update(wahaWorkers)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(wahaWorkers.id, workerId));

    this.logger.log(`Worker ${workerId} marked as stopped`);
  }
}
