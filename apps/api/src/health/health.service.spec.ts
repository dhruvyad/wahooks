import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { WahaService } from '../waha/waha.service';
import { WorkersService } from '../workers/workers.service';
import { DRIZZLE_TOKEN } from '../database/database.module';

describe('HealthService', () => {
  let service: HealthService;
  let db: any;
  let wahaService: jest.Mocked<Partial<WahaService>>;
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
    db = chainable();

    wahaService = {
      listSessions: jest.fn(),
      restartSession: jest.fn(),
    };

    workersService = {
      checkScaling: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: WahaService, useValue: wahaService },
        { provide: WorkersService, useValue: workersService },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

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

      // First where: active workers
      db.where.mockResolvedValueOnce([worker]);
      // listSessions for the worker
      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
      // DB sessions for worker
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

      db.where.mockResolvedValueOnce(workers);

      // First worker: listSessions throws
      wahaService.listSessions!.mockRejectedValueOnce(new Error('Connection refused'));
      // Second worker: listSessions succeeds with no sessions
      wahaService.listSessions!.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([]); // dbSessions for worker-fail

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
        .mockResolvedValueOnce(dbSessions) // db sessions for worker
        .mockResolvedValueOnce(undefined); // update call

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(db.update).toHaveBeenCalled();
    });

    it('should trigger restart when WAHA reports FAILED', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key' };
      const wahaSessionsList = [{ name: 's1', status: 'FAILED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'working' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
      wahaService.restartSession!.mockResolvedValueOnce(undefined);

      await service.pollWorkerHealth();

      expect(wahaService.restartSession).toHaveBeenCalledWith('10.0.0.1', 'key', 's1');
    });

    it('should mark session as failed in DB when restart after FAILED status throws', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key' };
      const wahaSessionsList = [{ name: 's1', status: 'FAILED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'working' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce(dbSessions)
        .mockResolvedValueOnce(undefined); // the update to 'failed'

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
      wahaService.restartSession!.mockRejectedValueOnce(new Error('Restart failed'));

      await service.pollWorkerHealth();

      expect(db.set).toHaveBeenCalled();
    });

    it('should trigger restart when WAHA reports STOPPED but DB says working', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key' };
      const wahaSessionsList = [{ name: 's1', status: 'STOPPED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'working' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);
      wahaService.restartSession!.mockResolvedValueOnce(undefined);

      await service.pollWorkerHealth();

      expect(wahaService.restartSession).toHaveBeenCalledWith('10.0.0.1', 'key', 's1');
    });

    it('should not restart when WAHA reports STOPPED and DB says stopped', async () => {
      const worker = { id: 'w1', internalIp: '10.0.0.1', apiKeyEnc: 'key' };
      const wahaSessionsList = [{ name: 's1', status: 'STOPPED' as const }];
      const dbSessions = [{ id: 'sid1', sessionName: 's1', status: 'stopped' }];

      db.where
        .mockResolvedValueOnce([worker])
        .mockResolvedValueOnce(dbSessions);

      wahaService.listSessions!.mockResolvedValueOnce(wahaSessionsList);

      await service.pollWorkerHealth();

      expect(wahaService.restartSession).not.toHaveBeenCalled();
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
