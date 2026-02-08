import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, lt, and, sql } from 'drizzle-orm';
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
        apiKey: worker.apiKeyEnc, // encryption handled later
      };
    }

    // No available workers — provision a new one
    this.logger.log('No available workers found, provisioning new worker...');
    const result = await this.orchestrator.provisionWorker();

    const [inserted] = await this.db
      .insert(wahaWorkers)
      .values({
        hetznerServerId: result.hetznerServerId,
        internalIp: result.internalIp,
        apiKeyEnc: result.apiKey, // encryption handled later
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
          currentSessions: sql`${wahaWorkers.currentSessions} - 1`,
          updatedAt: new Date(),
        })
        .where(eq(wahaWorkers.id, workerId));
    });

    this.logger.log(`Unassigned session ${sessionId} from worker ${workerId}`);
  }

  /**
   * Get worker details by ID.
   */
  async getWorker(workerId: string): Promise<{
    id: string;
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
   * Check if any worker needs scaling action.
   *
   * Scale up: if any active worker has utilization > 80%, provision a new worker.
   * Scale down: if ALL active workers have utilization < 30% and there are >1
   *   active workers, mark the emptiest as 'draining'.
   * For draining workers: if current_sessions === 0, destroy the VM.
   */
  async checkScaling(): Promise<void> {
    // Handle draining workers that are now empty
    const drainingWorkers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'draining'));

    for (const worker of drainingWorkers) {
      if (worker.currentSessions === 0) {
        this.logger.log(
          `Draining worker ${worker.id} has 0 sessions, destroying...`,
        );
        await this.destroyWorker(worker.id);
      }
    }

    // Check active workers for scaling decisions
    const activeWorkers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'active'));

    if (activeWorkers.length === 0) {
      this.logger.log('No active workers found, nothing to scale');
      return;
    }

    // Scale up: if any worker exceeds 80% utilization
    const needsScaleUp = activeWorkers.some(
      (w: any) => w.currentSessions / w.maxSessions > 0.8,
    );

    if (needsScaleUp) {
      this.logger.log(
        'Worker utilization > 80% detected, provisioning new worker for headroom',
      );
      await this.findOrProvisionWorker();
      return;
    }

    // Scale down: if ALL workers are below 30% utilization and there are >1 workers
    const allUnderThreshold = activeWorkers.every(
      (w: any) => w.currentSessions / w.maxSessions < 0.3,
    );

    if (allUnderThreshold && activeWorkers.length > 1) {
      // Find the emptiest worker
      const emptiest = activeWorkers.reduce((min: any, w: any) =>
        w.currentSessions < min.currentSessions ? w : min,
      );

      this.logger.log(
        `All workers below 30% utilization, draining worker ${emptiest.id} (${emptiest.currentSessions} sessions)`,
      );
      await this.drainWorker(emptiest.id);
    }
  }

  /**
   * Drain a worker (mark as draining, sessions will be migrated).
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

    // Get the hetzner server ID for orchestrator call
    const [row] = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.id, workerId))
      .limit(1);

    if (row?.hetznerServerId) {
      await this.orchestrator.destroyWorker(row.hetznerServerId);
      this.logger.log(
        `Destroyed Hetzner server ${row.hetznerServerId} for worker ${workerId}`,
      );
    }

    await this.db
      .update(wahaWorkers)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(wahaWorkers.id, workerId));

    this.logger.log(`Worker ${workerId} marked as stopped`);
  }
}
