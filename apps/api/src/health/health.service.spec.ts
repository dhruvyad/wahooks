import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';
import { WahaService } from '../waha/waha.service';
import { WorkersService } from '../workers/workers.service';
import { DRIZZLE_TOKEN } from '../database/database.module';

describe('HealthService', () => {
  let service: HealthService;
  let db: any;
  let wahaService: jest.Mocked<Partial<WahaService>> & { resolveSessionName: jest.Mock; resetSession: jest.Mock };
  let workersService: jest.Mocked<Partial<WorkersService>>;

  function chainable(resolvedValue: any = []) {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(resolvedValue),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    return chain;
  }

  beforeEach(async () => {
    // Crons are frozen-by-default during the session-recovery incident; run them
    // normally in tests. A dedicated test below asserts the freeze behavior.
    process.env.RECOVERY_FREEZE = 'false';
    db = chainable();

    wahaService = {
      listSessions: jest.fn(),
      restartSession: jest.fn(),
      resetSession: jest.fn(),
      stopSession: jest.fn(),
      deleteSession: jest.fn(),
      logoutSession: jest.fn(),
      createSession: jest.fn(),
      startSession: jest.fn(),
      resolveSessionName: jest.fn().mockImplementation((name: string) => name),
    };

    workersService = {
      checkScaling: jest.fn(),
      reconcileWorkerCounter: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: WahaService, useValue: wahaService },
        { provide: WorkersService, useValue: workersService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('http://localhost:3001') } },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  // pollWorkerHealth issues its DB queries in this order:
  //   1. active workers            (.where(eq(status,'active')))
  //   2. GLOBAL active session names for the orphan-safety set (.where(ne(status,'stopped')))
  //   3+. per-worker session reconcile / updates
  // Tests thread `db.where.mockResolvedValueOnce(...)` in that order.

  describe('pollWorkerHealth', () => {
    it('should return early when no active workers exist', async () => {
      db.where.mockResolvedValueOnce([]);

      await service.pollWorkerHealth();

      expect(wahaService.listSessions).not.toHaveBeenCalled();
    });

    it('should query active workers and reconcile session statuses', async () => {
      const worker = {
        id: 'worker-1',
        internalIp: '10.0.0.1',
        apiKeyEnc: 'key-1',
        status: 'active',
      };

      const wahaSessionsList = [
        { name: 'session-a', status: 'WORKING' as const },
      ];

      const dbSessions = [
        { id: 'sess-id-a', sessionName: 'session-a', status: 'scan_qr', workerId: 'worker-1' },
      ];

      // 1: active workers
      db.where.mockResolvedValueOnce([worker]);
      // 2: global active session names (orphan-safety set)
      db.where.mockResolvedValueOnce([{ sessionName: 'session-a' }]);
      // listSessions for the worker
      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
      // 3: DB sessions for worker
      db.where.mockResolvedValueOnce(dbSessions);
      // reconcileSessionStatus update call
      db.where.mockResolvedValueOnce(undefined);

      await service.pollWorkerHealth();

      expect(wahaService.listSessions).toHaveBeenCalledWith('10.0.0.1', 'key-1');
      // The db update should have been called to set status to 'working'
      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalled();
    });

    it('should handle errors for individual workers without stopping the loop', async () => {
      const workers = [
        { id: 'worker-ok', internalIp: '10.0.0.1', apiKeyEnc: 'key' },
        { id: 'worker-fail', internalIp: '10.0.0.2', apiKeyEnc: 'key' },
      ];

      db.where.mockResolvedValueOnce(workers); // 1: active workers
      db.where.mockResolvedValueOnce([]); // 2: global active names

      // First worker: listSessions throws
      wahaService.listSessions!.mockRejectedValueOnce(new Error('Connection refused'));
      // Second worker: listSessions succeeds with no sessions
      wahaService.listSessions!.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([]); // dbSessions for worker-ok (unreachable path)

      // Should not throw
      await expect(service.pollWorkerHealth()).resolves.not.toThrow();
    });
  });

  describe('reconcileSessionStatus', () => {
    // We test reconcileSessionStatus indirectly via pollWorkerHealth
    // since it's a private method. Each scenario sets up a worker+session combination.

    it('should update DB status to working when WAHA reports WORKING', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key' };
      const wahaSessionsList = [{ name: 's1', status: 'WORKING' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'scan_qr' }];

      db.where
        .mockResolvedValueOnce([worker]) // active workers
        .mockResolvedValueOnce([{ sessionName: 's1' }]) // global active names
        .mockResolvedValueOnce(dbSessions) // db sessions for worker
        .mockResolvedValueOnce(undefined); // update call

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(db.update).toHaveBeenCalled();
    });

    it('should restart (from persisted auth, no logout) when WAHA reports FAILED', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's1', status: 'FAILED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'working' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce([{ sessionName: 's1' }]) // global active names
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      // Recovers via a plain restart — never logs out / resets (which would nuke auth)
      expect(wahaService.restartSession).toHaveBeenCalledWith('10.0.0.1', 'key', 's1');
      expect(wahaService.resetSession).not.toHaveBeenCalled();
      expect(wahaService.logoutSession).not.toHaveBeenCalled();
    });

    it('should recover an already-failed session instead of orphan-stopping it', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's1', status: 'FAILED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'failed' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce([{ sessionName: 's1' }]) // global active names (failed is non-stopped)
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      // A failed session is a recovery target, not an orphan — restart it, don't stop it.
      expect(wahaService.restartSession).toHaveBeenCalledWith('10.0.0.1', 'key', 's1');
      expect(wahaService.stopSession).not.toHaveBeenCalled();
    });

    it('should start (from persisted auth) when WAHA reports STOPPED but DB expects it up', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's1', status: 'STOPPED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'working' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce([{ sessionName: 's1' }]) // global active names
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(wahaService.startSession).toHaveBeenCalledWith('10.0.0.1', 'key', 's1');
      expect(wahaService.resetSession).not.toHaveBeenCalled();
    });

    it('should not recover a soft-deleted (stopped) session', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's1', status: 'STOPPED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'stopped' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce([]) // global active names (s1 is stopped → not active anywhere)
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(wahaService.startSession).not.toHaveBeenCalled();
      expect(wahaService.restartSession).not.toHaveBeenCalled();
    });

    it('should mark failed only after exhausting bounded recovery attempts (never logging out)', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's1', status: 'FAILED' as const }];
      const dbSession = { id: 'sid1', sessionName: 's1', status: 'working' };

      // 5 attempts (MAX) — each restarts, none mark failed
      for (let i = 0; i < 5; i++) {
        db.where.mockReset();
        db.where
          .mockResolvedValueOnce([worker]) // active workers
          .mockResolvedValueOnce([{ sessionName: 's1' }]) // global active names
          .mockResolvedValueOnce([dbSession]); // db sessions for worker
        wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
        await service.pollWorkerHealth();
      }
      expect(wahaService.restartSession).toHaveBeenCalledTimes(5);
      expect(wahaService.resetSession).not.toHaveBeenCalled();
      expect(wahaService.logoutSession).not.toHaveBeenCalled();

      // 6th poll — attempts exhausted → mark failed for re-link, no further restart
      db.set.mockClear();
      db.where.mockReset();
      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce([{ sessionName: 's1' }]) // global active names
        .mockResolvedValueOnce([dbSession])
        .mockResolvedValueOnce(undefined);
      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
      await service.pollWorkerHealth();

      expect(wahaService.restartSession).toHaveBeenCalledTimes(5);
      expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });
  });

  describe('orphan cleanup', () => {
    it('deletes orphan WAHA sessions (no active DB record) and never touches "default" or stops them', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      // WAHA has an orphan session + the special "default"; DB has no records for them.
      const wahaSessionsList = [
        { name: 'u_x_s_orphan', status: 'STOPPED' as const },
        { name: 'default', status: 'STOPPED' as const },
      ];

      db.where
        .mockResolvedValueOnce([worker]) // active workers
        .mockResolvedValueOnce([]) // global active names (nothing active anywhere)
        .mockResolvedValueOnce([]); // db sessions for worker (none → both are orphans)

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(wahaService.deleteSession).toHaveBeenCalledWith('10.0.0.1', 'key', 'u_x_s_orphan');
      expect(wahaService.deleteSession).not.toHaveBeenCalledWith('10.0.0.1', 'key', 'default');
      expect(wahaService.deleteSession).toHaveBeenCalledTimes(1);
      // No longer merely stops orphans
      expect(wahaService.stopSession).not.toHaveBeenCalled();
    });

    it('does not delete a session that has an active DB record', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's-live', status: 'WORKING' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's-live', status: 'working', phoneNumber: '123' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce([{ sessionName: 's-live' }]) // global active names
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(wahaService.deleteSession).not.toHaveBeenCalled();
    });

    it('does NOT delete a stray duplicate of a session that is active on ANOTHER worker (incident regression)', async () => {
      // Worker w2 has a stray copy of "s-dup" (no DB record pointing at w2), but the
      // session is genuinely active on w1. Deleting the w2 copy would drop the shared
      // per-session store/auth DB and break the live session — the exact prod incident.
      const w2 = { id: 'w2', internalIp: '10.0.0.2', apiKeyEnc: 'key', status: 'active' };
      const wahaSessionsList = [{ name: 's-dup', status: 'WORKING' as const }];

      db.where
        .mockResolvedValueOnce([w2]) // active workers (only w2 in this poll)
        .mockResolvedValueOnce([{ sessionName: 's-dup' }]) // GLOBAL active names — s-dup active on w1
        .mockResolvedValueOnce([]); // db sessions for w2 (no record for s-dup here)

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(wahaService.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe('recovery freeze', () => {
    afterEach(() => {
      process.env.RECOVERY_FREEZE = 'false';
    });

    it('skips pollWorkerHealth when RECOVERY_FREEZE is not explicitly disabled', async () => {
      delete process.env.RECOVERY_FREEZE; // default => frozen
      db.where.mockResolvedValueOnce([{ id: 'w1' }]);

      await service.pollWorkerHealth();

      expect(wahaService.listSessions).not.toHaveBeenCalled();
    });

    it('skips checkScaling when frozen', async () => {
      process.env.RECOVERY_FREEZE = 'true';

      await service.checkScaling();

      expect(workersService.checkScaling).not.toHaveBeenCalled();
    });
  });

  describe('checkScaling', () => {
    it('should delegate to workersService.checkScaling', async () => {
      workersService.checkScaling!.mockResolvedValueOnce(undefined);

      await service.checkScaling();

      expect(workersService.checkScaling).toHaveBeenCalledTimes(1);
    });

    it('should not throw when workersService.checkScaling fails', async () => {
      workersService.checkScaling!.mockRejectedValueOnce(new Error('Scaling error'));

      await expect(service.checkScaling()).resolves.not.toThrow();
    });
  });
});
