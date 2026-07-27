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

  // Bounded, in-pod recovery tracking. A worker replacement briefly leaves
  // sessions FAILED/STOPPED even though their WhatsApp auth is still valid; we
  // restart them from persisted auth (no logout) rather than giving up. Keyed by
  // session id; cleared once a session recovers. Resets on pod restart, which is
  // desirable — a fresh pod should retry everything.
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly MAX_RECOVERY_ATTEMPTS = 5;

  // Orphan cleanup deletes lingering soft-deleted WAHA sessions from the pod.
  // Rate-limited per worker per poll so a large backlog clears gradually without
  // hammering the WAHA API.
  private readonly MAX_ORPHAN_DELETIONS_PER_POLL = 25;

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly wahaService: WahaService,
    private readonly workersService: WorkersService,
    private readonly configService: ConfigService,
  ) {}

  // EMERGENCY FREEZE 2026-07-27: session-recovery in progress. This cron restarts
  // WAHA sessions it sees as FAILED/STOPPED; for a session whose per-session store
  // DB was dropped, a restart rebuilds the socket from the (missing/empty) store and
  // mints a BLANK identity — permanently losing a customer number that cannot be
  // re-scanned. Frozen by default until every affected session's `creds` row is
  // persisted. Unfreeze with RECOVERY_FREEZE=false, then revert this guard.
  private frozen(name: string): boolean {
    if (process.env.RECOVERY_FREEZE !== 'false') {
      this.logger.warn(`${name} skipped — RECOVERY_FREEZE active (session recovery)`);
      return true;
    }
    return false;
  }

  @Cron('*/3 * * * *') // Every 3 minutes instead of every minute
  async pollWorkerHealth(): Promise<void> {
    if (this.frozen('pollWorkerHealth')) return;
    this.logger.log('Starting worker health poll...');

    const activeWorkers = await this.db
      .select()
      .from(wahaWorkers)
      .where(eq(wahaWorkers.status, 'active'));

    if (activeWorkers.length === 0) {
      this.logger.log('No active workers to check');
      return;
    }

    // Names of every session that belongs to ANY non-stopped session, across ALL
    // workers. A WAHA session is a true orphan — safe to DELETE — only if its name
    // is in nobody's active set. This is critical: a session can transiently exist
    // on the "wrong" worker (a stray duplicate of an active session), and deleting
    // it would drop the per-session store/auth DB (shared by name across pods),
    // breaking the live session. So orphan deletion keys off this GLOBAL set, not
    // the per-worker one.
    const allActive = await this.db
      .select({ sessionName: wahaSessions.sessionName })
      .from(wahaSessions)
      .where(ne(wahaSessions.status, 'stopped'));
    const globalActiveNames = new Set<string>(
      allActive.map((s: { sessionName: string }) =>
        this.wahaService.resolveSessionName(s.sessionName),
      ),
    );

    for (const worker of activeWorkers) {
      try {
        await this.checkWorkerSessions(worker, globalActiveNames);
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

  private async checkWorkerSessions(
    worker: any,
    globalActiveNames: Set<string>,
  ): Promise<void> {
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
        if (dbSession.status === 'stopped') {
          continue;
        }
        await this.tryAutoCreateSession(worker, dbSession);
      }
      return;
    }

    const wahaSessionMap = new Map(
      wahaSessions_.map((s) => [s.name, s.status]),
    );

    // Reconcile this worker's DB sessions against what WAHA actually reports.
    // Orphan detection below uses the GLOBAL active-name set (all workers), so we
    // no longer maintain a per-worker "expected" set here.
    for (const dbSession of dbSessions) {
      const wahaName = this.wahaService.resolveSessionName(
        dbSession.sessionName,
      );
      const wahaStatus = wahaSessionMap.get(wahaName);

      // Only truly stopped (soft-deleted) sessions are skipped. Everything else —
      // including "failed" — is a recovery target.
      if (dbSession.status === 'stopped') {
        continue;
      }

      if (!wahaStatus) {
        await this.tryAutoCreateSession(worker, dbSession);
        continue;
      }

      await this.reconcileSessionStatus(worker, dbSession, wahaStatus);
    }

    // Clean up orphan WAHA sessions — ones with no active (non-stopped) DB record.
    // These are soft-deleted / abandoned sessions still lingering on the pod.
    // DELETE them (not just stop) so they leave the session list permanently
    // instead of being re-stopped every poll; rate-limited so a large backlog
    // clears gradually. The `default` session (WAHA Core leftover) is never touched.
    //
    // CRITICAL: the orphan test keys off `globalActiveNames` (every non-stopped
    // session across ALL workers), NOT this worker's `expectedWahaNames`. A session
    // can transiently exist on the "wrong" worker as a stray duplicate of one that
    // is active on another worker; that copy is absent from this worker's DB set but
    // must NOT be deleted, because WAHA's DELETE drops the per-session store/auth DB
    // (keyed by session name, shared across pods) and would destroy the live session.
    let orphansDeleted = 0;
    for (const [wahaName] of wahaSessionMap) {
      if (globalActiveNames.has(wahaName) || wahaName === 'default') {
        continue;
      }
      if (orphansDeleted >= this.MAX_ORPHAN_DELETIONS_PER_POLL) {
        this.logger.log(
          `Orphan-deletion cap (${this.MAX_ORPHAN_DELETIONS_PER_POLL}) reached on worker ${worker.id} — remaining orphans will clear next poll`,
        );
        break;
      }
      orphansDeleted++;
      this.logger.log(
        `Deleting orphan WAHA session "${wahaName}" on worker ${worker.id} (no active DB record)`,
      );
      try {
        await this.wahaService.deleteSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to delete orphan "${wahaName}" on worker ${worker.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
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
        // Recovered (or healthy) — stop tracking recovery attempts.
        this.recoveryAttempts.delete(dbSession.id);
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
        // A definitive state (WhatsApp wants a fresh link) — recovery is done.
        this.recoveryAttempts.delete(dbSession.id);
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
        // Recover from persisted auth WITHOUT logging out (preserves the WhatsApp
        // link). A restart from valid auth returns to WORKING; a genuinely
        // logged-out session stays FAILED/goes to SCAN_QR. Only after exhausting
        // bounded retries do we mark it failed — and even then we never logout,
        // so a manual restart or future worker bounce can still recover it.
        await this.recoverSession(worker, dbSession, wahaName, 'restart');
        break;

      case 'STOPPED':
        // WAHA has the session but it isn't running while the DB expects it up
        // (common right after a worker replacement). Start it from persisted auth.
        if (dbStatus !== 'stopped') {
          await this.recoverSession(worker, dbSession, wahaName, 'start');
        }
        break;

      case 'STARTING':
        // Transitional state, no action needed (and don't count it as a failure)
        break;

      default:
        this.logger.warn(
          `Session "${sessionName}" has unknown WAHA status: ${wahaStatus}`,
        );
        break;
    }
  }

  /**
   * Bring a FAILED/STOPPED session back up from its persisted auth, without ever
   * logging out (which would destroy a still-valid WhatsApp link and force a
   * re-scan). Retries are bounded per pod lifetime; once exhausted we mark the
   * session `failed` so the user can re-link, but we still preserve the auth.
   */
  private async recoverSession(
    worker: any,
    dbSession: any,
    wahaName: string,
    action: 'restart' | 'start',
  ): Promise<void> {
    // Don't act on workers that are being drained/torn down.
    if (worker.status === 'draining' || worker.status === 'stopped') {
      return;
    }

    const attempts = this.recoveryAttempts.get(dbSession.id) ?? 0;

    if (attempts >= this.MAX_RECOVERY_ATTEMPTS) {
      // Recovery exhausted — the WhatsApp auth is most likely genuinely gone.
      // Surface it for re-linking, but do NOT logout: keep the auth so a manual
      // restart or a future worker bounce can still recover it.
      if (dbSession.status !== 'failed') {
        this.logger.warn(
          `Session "${dbSession.sessionName}" unrecoverable after ${attempts} attempts — marking failed for re-link (auth preserved)`,
        );
        await this.db
          .update(wahaSessions)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(wahaSessions.id, dbSession.id));
      }
      return;
    }

    this.recoveryAttempts.set(dbSession.id, attempts + 1);
    this.logger.warn(
      `Session "${dbSession.sessionName}" needs recovery — ${action} attempt ${attempts + 1}/${this.MAX_RECOVERY_ATTEMPTS} from persisted auth`,
    );

    try {
      if (action === 'restart') {
        await this.wahaService.restartSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
        );
      } else {
        await this.wahaService.startSession(
          worker.internalIp,
          worker.apiKeyEnc,
          wahaName,
        );
      }
    } catch (error) {
      this.logger.error(
        `Recovery ${action} failed for "${dbSession.sessionName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOrphanedWahaDatabases(): Promise<void> {
    if (this.frozen('cleanupOrphanedWahaDatabases')) return;
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
    if (this.frozen('checkScaling')) return;
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
