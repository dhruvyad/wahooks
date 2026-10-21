import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, lt, and, sql, ne, inArray } from 'drizzle-orm';
import { wahaWorkers, wahaSessions } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import {
  ORCHESTRATOR_TOKEN,
  ContainerOrchestrator,
  ProvisionResult,
} from '../orchestration/orchestrator.interface';

export interface ScaleUpFailure {
  reason: string;
  since: Date;
  lastAttemptAt: Date;
  failedAttempts: number;
}

type WorkerHandle = { id: string; internalIp: string; apiKey: string };

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);
  private readonly maxSessionsPerWorker: number;
  private provisioningInProgress = false;
  // Set while scale-ups keep failing; cleared by the next one that succeeds.
  private scaleUpFailure: ScaleUpFailure | null = null;

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
  async findOrProvisionWorker(): Promise<WorkerHandle> {
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

    // No worker has capacity — provision a brand-new one.
    return this.provisionNewWorker();
  }

  /**
   * Add a worker unconditionally — does NOT reuse an existing partially-full
   * worker. Used for proactive pre-warming (so a second machine is ready
   * before the current one fills) and as the fallback inside
   * findOrProvisionWorker when no worker has capacity. A ready pod nobody
   * registered is adopted before the orchestrator is asked for a new one.
   *
   * Throws if a provision is already in progress so the caller can back off
   * (e.g. return the connection as 'pending' or skip this scaling tick).
   */
  async provisionNewWorker(): Promise<WorkerHandle> {
    if (this.provisioningInProgress) {
      throw new Error('Worker provisioning already in progress');
    }

    this.provisioningInProgress = true;
    this.logger.log('Provisioning new worker...');

    try {
      const [adopted] = await this.adoptReadyWorkers();
      const worker =
        adopted ?? (await this.registerWorker(await this.orchestrator.provisionWorker()));
      this.scaleUpFailure = null;
      this.logger.log(`Provisioned new worker ${worker.id} at ${worker.internalIp}`);
      return worker;
    } catch (error) {
      this.recordScaleUpFailure(error);
      throw error;
    } finally {
      this.provisioningInProgress = false;
    }
  }

  /**
   * Register every ready worker pod whose row is missing or stopped. A pod
   * whose provision timed out, or that a scale-down could not remove, keeps
   * running without taking sessions until it is adopted. A draining row is
   * left alone: that worker is being emptied on purpose.
   */
  async adoptReadyWorkers(): Promise<WorkerHandle[]> {
    const ready = await this.orchestrator.listReadyWorkers();
    if (ready.length === 0) return [];

    const rows: Array<{ podName: string; status: string }> = await this.db
      .select({ podName: wahaWorkers.podName, status: wahaWorkers.status })
      .from(wahaWorkers)
      .where(inArray(wahaWorkers.podName, ready.map((w) => w.podName)));
    const statusByPod = new Map(rows.map((r) => [r.podName, r.status]));

    const adopted: WorkerHandle[] = [];
    for (const pod of ready) {
      const status = statusByPod.get(pod.podName);
      if (status === 'active' || status === 'draining') continue;
      this.logger.log(`Adopting ready pod ${pod.podName} (worker row: ${status ?? 'none'})`);
      adopted.push(await this.registerWorker(pod));
    }
    return adopted;
  }

  /** Why scale-ups are failing, or null when the last one succeeded. */
  getScaleUpFailure(): ScaleUpFailure | null {
    return this.scaleUpFailure;
  }

  private recordScaleUpFailure(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const now = new Date();
    this.scaleUpFailure = {
      reason,
      since: this.scaleUpFailure?.since ?? now,
      lastAttemptAt: now,
      failedAttempts: (this.scaleUpFailure?.failedAttempts ?? 0) + 1,
    };
    this.logger.error(
      `Worker scale-up failed (${this.scaleUpFailure.failedAttempts} in a row since ${this.scaleUpFailure.since.toISOString()}): ${reason}`,
    );
  }

  /**
   * Upsert on pod_name: a StatefulSet reuses ordinals, so a pod like waha-1
   * may already have a (stopped) row from an earlier drain. Reactivate it with
   * today's session cap instead of hitting the unique-podName constraint.
   */
  private async registerWorker(result: ProvisionResult): Promise<WorkerHandle> {
    const [row] = await this.db
      .insert(wahaWorkers)
      .values({
        podName: result.podName,
        internalIp: result.internalIp,
        apiKeyEnc: result.apiKey,
        status: 'active',
        maxSessions: this.maxSessionsPerWorker,
      })
      .onConflictDoUpdate({
        target: wahaWorkers.podName,
        set: {
          internalIp: result.internalIp,
          apiKeyEnc: result.apiKey,
          status: 'active',
          currentSessions: 0,
          maxSessions: this.maxSessionsPerWorker,
          updatedAt: new Date(),
        },
      })
      .returning();

    return { id: row.id, internalIp: row.internalIp, apiKey: row.apiKeyEnc };
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
   *
   * Counts only LIVE sessions (working, scan_qr, pending) — a `failed` session
   * holds no active WhatsApp connection, so it must not consume a capacity slot
   * (maxSessions caps concurrent active load, not total session objects). This
   * keeps scaling / worker-selection driven by real load, not dead connections.
   */
  async reconcileWorkerCounter(workerId: string): Promise<void> {
    const actualCount = await this.db
      .select({ count: sql`count(*)` })
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.workerId, workerId),
          inArray(wahaSessions.status, ['working', 'scan_qr', 'pending']),
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
    // 0. Put every ready pod to work before judging capacity
    try {
      await this.adoptReadyWorkers();
    } catch (error) {
      this.logger.error(
        `Adopting ready workers failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

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

    // 3. Scale up: reactive (full + pending) or proactive (low remaining capacity)
    const totalCapacity = workers.reduce((sum: number, w: any) => sum + w.maxSessions, 0);
    const totalUsed = workers.reduce((sum: number, w: any) => sum + w.currentSessions, 0);
    const remainingSlots = totalCapacity - totalUsed;
    const PROACTIVE_THRESHOLD = 10; // Pre-warm when fewer than 10 slots remain

    const hasAvailableCapacity = remainingSlots > 0;

    if (!hasAvailableCapacity) {
      // Reactive: all workers full, check for pending sessions
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
        } catch {
          // provisionNewWorker recorded and logged why
        }
        return;
      }
    } else if (remainingSlots <= PROACTIVE_THRESHOLD && !this.provisioningInProgress) {
      // Proactive: capacity getting low, pre-warm a NEW worker. Must provision
      // unconditionally — findOrProvisionWorker would just hand back the current
      // worker (which still has a free slot) and never add a machine, so the
      // pre-warm never happened and #51 hit a cold start.
      this.logger.log(
        `Proactive scale-up: only ${remainingSlots} slots remaining across ${workers.length} workers (threshold: ${PROACTIVE_THRESHOLD}) — provisioning`,
      );
      try {
        await this.provisionNewWorker();
      } catch {
        // provisionNewWorker recorded and logged why
      }
      return;
    }

    // 4. Scale down: if ALL workers below 30% and >1 workers
    if (workers.length <= 1) return;

    const allUnderThreshold = workers.every(
      (w: any) => w.currentSessions / w.maxSessions < 0.3,
    );

    if (allUnderThreshold) {
      // Only the highest-ordinal pod can leave a StatefulSet; draining any
      // other worker would stop its sessions and then keep the pod anyway.
      const target = [...workers].sort(
        (a: any, b: any) => this.ordinal(b.podName) - this.ordinal(a.podName),
      )[0];

      // Never drain a worker with 'working' sessions (active WhatsApp connections)
      const [working] = await this.db
        .select({ count: sql`count(*)` })
        .from(wahaSessions)
        .where(
          and(
            eq(wahaSessions.workerId, target.id),
            eq(wahaSessions.status, 'working'),
          ),
        );

      if (Number(working?.count ?? 0) > 0) {
        this.logger.log(
          `All workers below 30% but ${target.podName} (highest ordinal) has working sessions — skipping drain`,
        );
        return;
      }

      this.logger.log(
        `All workers below 30%, draining ${target.podName} (${target.currentSessions} sessions, 0 working)`,
      );

      // Stop non-working sessions (scan_qr, pending, failed) on this worker
      if (target.currentSessions > 0) {
        await this.db
          .update(wahaSessions)
          .set({ status: 'stopped', workerId: null })
          .where(
            and(
              eq(wahaSessions.workerId, target.id),
              ne(wahaSessions.status, 'stopped'),
              ne(wahaSessions.status, 'working'),
            ),
          );
        await this.reconcileWorkerCounter(target.id);
      }

      await this.drainWorker(target.id);
    }
  }

  private ordinal(podName: string | null | undefined): number {
    return parseInt(podName?.match(/-(\d+)$/)?.[1] ?? '0', 10);
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
      let removed: boolean;
      try {
        removed = await this.orchestrator.destroyWorker(worker.podName);
      } catch (error) {
        this.logger.warn(
          `Failed to destroy pod ${worker.podName}: ${error instanceof Error ? error.message : String(error)} — worker ${workerId} stays draining, retrying next check`,
        );
        return;
      }
      // A pod the orchestrator kept is still running; marking it stopped
      // would strand it (and adoption would revive it into another drain).
      if (!removed) {
        this.logger.warn(
          `Pod ${worker.podName} was kept by the orchestrator — worker ${workerId} stays draining until it can be removed`,
        );
        return;
      }
      this.logger.log(
        `Destroyed worker pod ${worker.podName} for worker ${workerId}`,
      );
    }

    await this.db
      .update(wahaWorkers)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(eq(wahaWorkers.id, workerId));

    this.logger.log(`Worker ${workerId} marked as stopped`);
  }
}
