import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, lt, and, sql, ne, inArray, or } from 'drizzle-orm';
import { wahaWorkers, wahaSessions, WORKER_KINDS } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import {
  WORKER_ORCHESTRATORS_TOKEN,
  WorkerKind,
  WorkerOrchestrators,
  ProvisionResult,
} from '../orchestration/orchestrator.interface';

/**
 * A WAHA pod holding a session in one of these is never drained: 'working' is live, and 'failed' still has its
 * auth (the health poll stopped it, or a migration froze it while it moves to a gateway).
 */
export const DRAIN_BLOCKING_STATUSES = ['working', 'failed'] as const;
/** Sessions a drain marks 'stopped': ones that never linked a device. */
export const DRAIN_STOPPABLE_STATUSES = ['scan_qr', 'pending'] as const;

export interface ScaleUpFailure {
  kind: WorkerKind;
  reason: string;
  since: Date;
  lastAttemptAt: Date;
  failedAttempts: number;
}

export type WorkerHandle = {
  id: string;
  internalIp: string;
  apiKey: string;
  kind: WorkerKind;
};

/** Gateway reachability as the last health poll saw it (GET /api/health). */
export interface GatewayHealth {
  checkedAt: Date;
  boxes: Array<{
    id: string;
    podName: string;
    reachable: boolean;
    unreachableSince: Date | null;
  }>;
}

export interface GatewayScaleDecision {
  scaleUp: boolean;
  used: number;
  capacity: number;
  ratio: number;
}

/**
 * Should the gateway fleet grow? Rows with max_sessions 0 are boxes pinned by
 * hand (they take no new connections) and count for neither load nor room.
 * With no room at all, a box is needed only while new connections go to
 * gateways.
 */
export function gatewayScaleDecision(
  workers: Array<{ currentSessions: number; maxSessions: number }>,
  scaleUpAt: number,
  placingNewConnections: boolean,
): GatewayScaleDecision {
  const sized = workers.filter((w) => w.maxSessions > 0);
  const capacity = sized.reduce((sum, w) => sum + w.maxSessions, 0);
  const used = sized.reduce((sum, w) => sum + w.currentSessions, 0);
  if (capacity === 0) {
    return {
      scaleUp: placingNewConnections,
      used,
      capacity,
      ratio: placingNewConnections ? Infinity : 0,
    };
  }
  const ratio = used / capacity;
  return { scaleUp: ratio >= scaleUpAt, used, capacity, ratio };
}

const kindOf = (worker: { kind?: string | null }): WorkerKind =>
  worker.kind === 'gateway' ? 'gateway' : 'waha';

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);
  /** Session cap a newly registered row of each kind gets. */
  private readonly maxSessions: Record<WorkerKind, number>;
  /** Where new connections are placed (NEW_CONNECTION_WORKER_KIND). */
  readonly newConnectionKind: WorkerKind;
  /** Gateway used/capacity at which another box is provisioned (GATEWAY_SCALE_UP_AT). */
  private readonly gatewayScaleUpAt: number;
  // One provision at a time per kind: a WAHA pod and a gateway box can be
  // added together, but never two of the same kind.
  private readonly provisioning: Record<WorkerKind, boolean> = { waha: false, gateway: false };
  // Set per kind while scale-ups keep failing; cleared by the next success.
  private readonly scaleUpFailures: Partial<Record<WorkerKind, ScaleUpFailure>> = {};
  private gatewayHealth: GatewayHealth | null = null;

  // worker id → kind, for the event ingestion hot path (no query per event).
  private workerKinds = new Map<string, WorkerKind>();
  private workerKindsLoadedAt = 0;
  private workerKindsLoad: Promise<void> | null = null;
  private readonly WORKER_KIND_TTL_MS = 60_000;
  private readonly WORKER_KIND_MISS_REFRESH_MS = 5_000;

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    @Inject(WORKER_ORCHESTRATORS_TOKEN)
    private readonly orchestrators: WorkerOrchestrators,
    private readonly configService: ConfigService,
  ) {
    this.maxSessions = {
      waha: Number(this.configService.get('WAHA_MAX_SESSIONS', '1')),
      gateway: this.positiveInt('GATEWAY_MAX_SESSIONS', 5000),
    };

    const kind = String(this.configService.get('NEW_CONNECTION_WORKER_KIND') ?? 'waha').trim();
    if ((WORKER_KINDS as readonly string[]).includes(kind)) {
      this.newConnectionKind = kind as WorkerKind;
    } else {
      this.logger.warn(`NEW_CONNECTION_WORKER_KIND must be 'waha' or 'gateway' — using 'waha'`);
      this.newConnectionKind = 'waha';
    }

    const scaleUpAt = Number(this.configService.get('GATEWAY_SCALE_UP_AT') ?? 0.8);
    if (scaleUpAt > 0 && scaleUpAt <= 1) {
      this.gatewayScaleUpAt = scaleUpAt;
    } else {
      this.logger.warn('GATEWAY_SCALE_UP_AT must be in (0, 1] — using 0.8');
      this.gatewayScaleUpAt = 0.8;
    }

    if (this.newConnectionKind === 'gateway' && !this.orchestrators.gateway) {
      this.logger.warn(
        'New connections go to gateway workers, but no gateway orchestrator is configured: only boxes registered by hand can take them',
      );
    }
  }

  private positiveInt(key: string, fallback: number): number {
    const raw = this.configService.get(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    this.logger.warn(`${key} must be a positive integer — using ${fallback}`);
    return fallback;
  }

  /**
   * Find a worker of `kind` (default: where new connections go) with available
   * capacity, least-loaded first, or provision a new one.
   */
  async findOrProvisionWorker(kind: WorkerKind = this.newConnectionKind): Promise<WorkerHandle> {
    const available = await this.db
      .select()
      .from(wahaWorkers)
      .where(
        and(
          eq(wahaWorkers.status, 'active'),
          eq(wahaWorkers.kind, kind),
          lt(wahaWorkers.currentSessions, wahaWorkers.maxSessions),
        ),
      )
      .orderBy(wahaWorkers.currentSessions)
      .limit(1);

    if (available.length > 0) {
      const worker = available[0];
      this.logger.log(
        `Found available ${kind} worker ${worker.id} (${worker.currentSessions}/${worker.maxSessions} sessions)`,
      );
      return this.handle(worker, kind);
    }

    // No worker has capacity — provision a brand-new one.
    return this.provisionNewWorker(kind);
  }

  /**
   * Add a worker of `kind` unconditionally — does NOT reuse an existing
   * partially-full worker. Used for proactive pre-warming (so a second machine
   * is ready before the current one fills) and as the fallback inside
   * findOrProvisionWorker when no worker has capacity. A ready worker nobody
   * registered is adopted before the orchestrator is asked for a new one.
   *
   * Throws if a provision of that kind is already in progress so the caller
   * can back off (e.g. return the connection as 'pending' or skip this tick).
   */
  async provisionNewWorker(kind: WorkerKind = this.newConnectionKind): Promise<WorkerHandle> {
    const orchestrator = this.orchestrators[kind];
    if (!orchestrator) {
      const error = new Error(
        `No orchestrator for ${kind} workers (set the GATEWAY_* env to let the API create gateway boxes)`,
      );
      this.recordScaleUpFailure(kind, error);
      throw error;
    }
    if (this.provisioning[kind]) {
      throw new Error(`Worker provisioning already in progress (${kind})`);
    }

    this.provisioning[kind] = true;
    this.logger.log(`Provisioning new ${kind} worker...`);

    try {
      const [adopted] = await this.adoptReadyWorkers(kind);
      const worker =
        adopted ??
        (await this.registerWorker(
          kind,
          await orchestrator.provisionWorker({
            // Persist a slow-booting box's key before waiting on it, so the
            // next scaling check can adopt it even if this process is gone.
            onCreated: (created) => this.recordProvisioningWorker(kind, created),
          }),
        ));
      delete this.scaleUpFailures[kind];
      this.logger.log(`Provisioned new ${kind} worker ${worker.id} at ${worker.internalIp}`);
      return worker;
    } catch (error) {
      this.recordScaleUpFailure(kind, error);
      throw error;
    } finally {
      this.provisioning[kind] = false;
    }
  }

  /**
   * Register every ready worker of `kind` whose row is missing, stopped or
   * still provisioning. A pod whose provision timed out, or that a scale-down
   * could not remove, keeps running without taking sessions until it is
   * adopted. A draining row is left alone: that worker is being emptied on
   * purpose. Rows are matched on internal_ip as well as name, so a box
   * registered by hand under another name is never registered twice.
   */
  async adoptReadyWorkers(kind: WorkerKind = 'waha'): Promise<WorkerHandle[]> {
    const orchestrator = this.orchestrators[kind];
    if (!orchestrator) return [];
    const ready = await orchestrator.listReadyWorkers();
    if (ready.length === 0) return [];

    const rows: Array<{
      id: string;
      podName: string;
      internalIp: string | null;
      status: string;
      apiKeyEnc: string;
    }> = await this.db
      .select({
        id: wahaWorkers.id,
        podName: wahaWorkers.podName,
        internalIp: wahaWorkers.internalIp,
        status: wahaWorkers.status,
        apiKeyEnc: wahaWorkers.apiKeyEnc,
      })
      .from(wahaWorkers)
      .where(
        or(
          inArray(wahaWorkers.podName, ready.map((w) => w.podName)),
          inArray(wahaWorkers.internalIp, ready.map((w) => w.internalIp)),
        ),
      );
    const byName = new Map(rows.map((r) => [r.podName, r]));
    const byIp = new Map(rows.filter((r) => r.internalIp).map((r) => [r.internalIp, r]));

    const adopted: WorkerHandle[] = [];
    for (const pod of ready) {
      const named = byName.get(pod.podName);
      const row = named ?? byIp.get(pod.internalIp);
      if (row?.status === 'active' || row?.status === 'draining') continue;
      const apiKey = pod.apiKey || row?.apiKeyEnc;
      if (!apiKey) {
        this.logger.warn(
          `Ready ${kind} worker ${pod.podName} at ${pod.internalIp} has no worker row, so its API key is unknown — not adopting it (register it by hand or delete it)`,
        );
        continue;
      }
      this.logger.log(
        `Adopting ready ${kind} worker ${pod.podName} (worker row: ${row ? `${row.podName} ${row.status}` : 'none'})`,
      );
      // A row found only by address keeps its own name.
      adopted.push(await this.registerWorker(kind, { ...pod, apiKey }, named ? undefined : row?.id));
    }
    return adopted;
  }

  /** Why scale-ups are failing (the longest-failing kind), or null when none is. */
  getScaleUpFailure(): ScaleUpFailure | null {
    const failures = Object.values(this.scaleUpFailures) as ScaleUpFailure[];
    if (failures.length === 0) return null;
    return failures.sort((a, b) => a.since.getTime() - b.since.getTime())[0];
  }

  private recordScaleUpFailure(kind: WorkerKind, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const now = new Date();
    const previous = this.scaleUpFailures[kind];
    const failure: ScaleUpFailure = {
      kind,
      reason,
      since: previous?.since ?? now,
      lastAttemptAt: now,
      failedAttempts: (previous?.failedAttempts ?? 0) + 1,
    };
    this.scaleUpFailures[kind] = failure;
    this.logger.error(
      `${kind === 'gateway' ? 'Gateway' : 'Worker'} scale-up failed (${failure.failedAttempts} in a row since ${failure.since.toISOString()}): ${reason}`,
    );
  }

  /**
   * Upsert on pod_name: a StatefulSet reuses ordinals, so a pod like waha-1
   * may already have a (stopped) row from an earlier drain. Reactivate it with
   * today's session cap instead of hitting the unique-podName constraint. With
   * `rowId` (a row matched by address), that row is reactivated instead.
   */
  private async registerWorker(
    kind: WorkerKind,
    result: ProvisionResult,
    rowId?: string,
  ): Promise<WorkerHandle> {
    const maxSessions = this.maxSessions[kind];
    const activate = {
      internalIp: result.internalIp,
      apiKeyEnc: result.apiKey,
      status: 'active' as const,
      kind,
      currentSessions: 0,
      maxSessions,
      updatedAt: new Date(),
    };
    const [row] = rowId
      ? await this.db
          .update(wahaWorkers)
          .set(activate)
          .where(eq(wahaWorkers.id, rowId))
          .returning()
      : await this.db
          .insert(wahaWorkers)
          .values({
            podName: result.podName,
            internalIp: result.internalIp,
            apiKeyEnc: result.apiKey,
            status: 'active',
            kind,
            maxSessions,
          })
          .onConflictDoUpdate({ target: wahaWorkers.podName, set: activate })
          .returning();

    this.workerKinds.set(row.id, kind);
    return this.handle(row, kind);
  }

  /** A created-but-not-ready worker: its key is kept, nothing is placed on it. */
  private async recordProvisioningWorker(
    kind: WorkerKind,
    result: ProvisionResult,
  ): Promise<void> {
    const row = {
      internalIp: result.internalIp,
      apiKeyEnc: result.apiKey,
      status: 'provisioning' as const,
      kind,
      maxSessions: this.maxSessions[kind],
    };
    await this.db
      .insert(wahaWorkers)
      .values({ podName: result.podName, ...row })
      .onConflictDoUpdate({
        target: wahaWorkers.podName,
        set: { ...row, updatedAt: new Date() },
      });
    this.logger.log(`Recorded ${kind} worker ${result.podName} (${result.internalIp}) as provisioning`);
  }

  private handle(row: any, kind: WorkerKind): WorkerHandle {
    return {
      id: row.id,
      internalIp: row.internalIp,
      apiKey: row.apiKeyEnc,
      kind: row.kind ? kindOf(row) : kind,
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
    kind: WorkerKind;
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
      kind: kindOf(w),
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
    kind: WorkerKind;
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
      kind: worker.kind,
    };
  }

  /**
   * A worker's kind, from a cache of every row refreshed at most once a
   * minute (or a few seconds after a miss, for a row registered since). For
   * event ingestion, which must not query the database per event for it.
   * Null when no such worker exists.
   */
  async getWorkerKind(workerId: string): Promise<WorkerKind | null> {
    const age = Date.now() - this.workerKindsLoadedAt;
    const cached = this.workerKinds.get(workerId);
    if (cached && age < this.WORKER_KIND_TTL_MS) return cached;
    if (!cached && age < this.WORKER_KIND_MISS_REFRESH_MS) return null;
    await this.loadWorkerKinds();
    return this.workerKinds.get(workerId) ?? null;
  }

  private loadWorkerKinds(): Promise<void> {
    // One query for however many events are waiting on it.
    this.workerKindsLoad ??= (async () => {
      try {
        const rows: Array<{ id: string; kind: string }> = await this.db
          .select({ id: wahaWorkers.id, kind: wahaWorkers.kind })
          .from(wahaWorkers);
        this.workerKinds = new Map(rows.map((r) => [r.id, kindOf(r)]));
        this.workerKindsLoadedAt = Date.now();
      } finally {
        this.workerKindsLoad = null;
      }
    })();
    return this.workerKindsLoad;
  }

  /** The health poll's verdict on each active gateway box. */
  recordGatewayHealth(results: Array<{ id: string; podName: string; reachable: boolean }>): void {
    const now = new Date();
    const previous = new Map((this.gatewayHealth?.boxes ?? []).map((b) => [b.id, b]));
    this.gatewayHealth = {
      checkedAt: now,
      boxes: results.map((r) => ({
        ...r,
        unreachableSince: r.reachable ? null : (previous.get(r.id)?.unreachableSince ?? now),
      })),
    };
  }

  /** Null until the first health poll has run in this process. */
  getGatewayHealth(): GatewayHealth | null {
    return this.gatewayHealth;
  }

  /**
   * List all active workers.
   */
  async listWorkers(): Promise<
    Array<{
      id: string;
      status: string;
      kind: WorkerKind;
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
      kind: kindOf(w),
      currentSessions: w.currentSessions,
      maxSessions: w.maxSessions,
    }));
  }

  /**
   * Check scaling needs. Called by health service every 5 minutes.
   *
   * Every kind: adopt ready workers, reconcile counters, destroy drained WAHA
   * pods. Then per kind — WAHA: today's rules over WAHA rows (to zero once new
   * connections go to gateways and no WAHA session is left); gateway: add a
   * box at GATEWAY_SCALE_UP_AT, never remove one automatically.
   */
  async checkScaling(): Promise<void> {
    // 0. Put every ready worker to work before judging capacity
    for (const kind of WORKER_KINDS) {
      if (!this.orchestrators[kind]) continue;
      try {
        await this.adoptReadyWorkers(kind);
      } catch (error) {
        this.logger.error(
          `Adopting ready ${kind} workers failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
        if (kindOf(worker) === 'gateway') {
          // Its failed sessions' auth lives in the shared store under this
          // box's id; removing a box stays a human decision.
          this.logger.log(
            `Draining gateway ${updated.podName} holds no live session — delete the box by hand, then mark worker ${worker.id} stopped`,
          );
          continue;
        }
        this.logger.log(
          `Draining worker ${worker.id} (${updated.podName}) has 0 sessions, destroying...`,
        );
        await this.destroyWorker(worker.id, {
          allowLast: this.newConnectionKind === 'gateway' && (await this.wahaSessionCount()) === 0,
        });
      }
    }

    await this.checkWahaScaling(workers.filter((w: any) => kindOf(w) === 'waha'));
    await this.checkGatewayScaling(workers.filter((w: any) => kindOf(w) === 'gateway'));
  }

  private async checkWahaScaling(workers: any[]): Promise<void> {
    if (workers.length === 0) {
      this.logger.log('No active WAHA workers, nothing to scale');
      return;
    }

    // 3. Scale up: reactive (full + pending) or proactive (low remaining
    // capacity) — only while new connections are placed on WAHA.
    if (this.newConnectionKind === 'waha') {
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

        if (pendingSessions.length > 0 && !this.provisioning.waha) {
          this.logger.log(
            `All ${workers.length} workers at capacity, ${pendingSessions.length} pending — provisioning`,
          );
          try {
            await this.findOrProvisionWorker('waha');
          } catch {
            // provisionNewWorker recorded and logged why
          }
          return;
        }
      } else if (remainingSlots <= PROACTIVE_THRESHOLD && !this.provisioning.waha) {
        // Proactive: capacity getting low, pre-warm a NEW worker. Must provision
        // unconditionally — findOrProvisionWorker would just hand back the current
        // worker (which still has a free slot) and never add a machine, so the
        // pre-warm never happened and #51 hit a cold start.
        this.logger.log(
          `Proactive scale-up: only ${remainingSlots} slots remaining across ${workers.length} workers (threshold: ${PROACTIVE_THRESHOLD}) — provisioning`,
        );
        try {
          await this.provisionNewWorker('waha');
        } catch {
          // provisionNewWorker recorded and logged why
        }
        return;
      }
    } else if ((await this.wahaSessionCount()) === 0) {
      // 4a. To zero: new connections go to gateways and no WAHA worker holds a
      // session. One pod per check, highest ordinal first; the last one goes
      // too (destroyWorker passes allowLast).
      const target = this.highestOrdinal(workers);
      this.logger.log(
        `No WAHA worker holds a session and new connections go to gateways — draining ${target.podName}`,
      );
      await this.drainWorker(target.id);
      return;
    }

    // 4b. Scale down: if ALL workers below 30% and >1 workers
    if (workers.length <= 1) return;

    const allUnderThreshold = workers.every(
      (w: any) => w.currentSessions / w.maxSessions < 0.3,
    );

    if (allUnderThreshold) {
      // Only the highest-ordinal pod can leave a StatefulSet; draining any
      // other worker would stop its sessions and then keep the pod anyway.
      const target = this.highestOrdinal(workers);

      // Never drain a worker with 'working' or 'failed' sessions. A failed session still has its auth (the
      // health poll stops it, keeps the login and marks it failed; a migration freezes a session as failed
      // while it moves to a gateway); marking it stopped below would soft-delete a linked connection, and on a
      // gateway the orphan sweep would then unlink it.
      const [live] = await this.db
        .select({ count: sql`count(*)` })
        .from(wahaSessions)
        .where(
          and(
            eq(wahaSessions.workerId, target.id),
            inArray(wahaSessions.status, [...DRAIN_BLOCKING_STATUSES]),
          ),
        );

      if (Number(live?.count ?? 0) > 0) {
        this.logger.log(
          `All workers below 30% but ${target.podName} (highest ordinal) has working or failed sessions — skipping drain`,
        );
        return;
      }

      this.logger.log(
        `All workers below 30%, draining ${target.podName} (${target.currentSessions} sessions, none working or failed)`,
      );

      // Stop the sessions that never linked (scan_qr, pending) on this worker
      if (target.currentSessions > 0) {
        await this.db
          .update(wahaSessions)
          .set({ status: 'stopped', workerId: null })
          .where(
            and(
              eq(wahaSessions.workerId, target.id),
              inArray(wahaSessions.status, [...DRAIN_STOPPABLE_STATUSES]),
            ),
          );
        await this.reconcileWorkerCounter(target.id);
      }

      await this.drainWorker(target.id);
    }
  }

  /**
   * Gateways: add a box once used/capacity reaches GATEWAY_SCALE_UP_AT. Boxes
   * are never removed automatically: a box owns its accounts in the shared
   * store, and its DELETE unlinks a device for good.
   */
  private async checkGatewayScaling(gateways: any[]): Promise<void> {
    const decision = gatewayScaleDecision(
      gateways,
      this.gatewayScaleUpAt,
      this.newConnectionKind === 'gateway',
    );
    const load =
      decision.capacity > 0
        ? `${decision.used}/${decision.capacity} sessions (${Math.round(decision.ratio * 100)}%)`
        : `${decision.used} sessions and no free gateway capacity`;

    if (decision.scaleUp) {
      if (!this.orchestrators.gateway) {
        this.logger.warn(
          `Gateway fleet at ${load} — no gateway orchestrator configured, so no box is added`,
        );
        return;
      }
      if (this.provisioning.gateway) {
        this.logger.log(`Gateway fleet at ${load} — a box is already being provisioned`);
        return;
      }
      this.logger.log(
        `Gateway scale-up: ${load} across ${gateways.length} boxes (threshold ${Math.round(this.gatewayScaleUpAt * 100)}%) — provisioning a box`,
      );
      try {
        await this.provisionNewWorker('gateway');
      } catch {
        // provisionNewWorker recorded and logged why
      }
      return;
    }

    if (gateways.length > 1 && decision.capacity > 0 && decision.ratio < 0.3) {
      this.logger.log(
        `Gateway fleet at ${load} across ${gateways.length} boxes — scale-down is manual`,
      );
    }
  }

  /** Non-stopped sessions on WAHA workers that still exist (not stopped). */
  private async wahaSessionCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql`count(*)` })
      .from(wahaSessions)
      .innerJoin(wahaWorkers, eq(wahaSessions.workerId, wahaWorkers.id))
      .where(
        and(
          eq(wahaWorkers.kind, 'waha'),
          ne(wahaWorkers.status, 'stopped'),
          ne(wahaSessions.status, 'stopped'),
        ),
      );
    return Number(row?.count ?? 0);
  }

  private highestOrdinal(workers: any[]): any {
    return [...workers].sort(
      (a: any, b: any) => this.ordinal(b.podName) - this.ordinal(a.podName),
    )[0];
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
   * Destroy a worker (only if drained, current_sessions === 0). `allowLast`
   * lets the orchestrator remove its last worker.
   */
  async destroyWorker(workerId: string, opts: { allowLast?: boolean } = {}): Promise<void> {
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

    const orchestrator = this.orchestrators[worker.kind];
    if (worker.podName && !orchestrator) {
      this.logger.warn(
        `Cannot destroy ${worker.kind} worker ${worker.podName}: no orchestrator for that kind — remove it by hand`,
      );
      return;
    }

    if (worker.podName && orchestrator) {
      let removed: boolean;
      try {
        removed = await orchestrator.destroyWorker(worker.podName, {
          allowLast: opts.allowLast ?? false,
        });
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
