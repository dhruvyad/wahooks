import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { ORCHESTRATOR_TOKEN } from '../orchestration/orchestrator.interface';

/**
 * Creates a mock DB where each method returns a proxy that is:
 * - callable (`.select()`, `.from()`, etc. all return a new chain)
 * - awaitable (when you await the chain, it pops the next result from a queue)
 *
 * The db object itself tracks calls to the first method in each chain via jest.fn().
 * Subsequent methods in the chain are handled by the proxy.
 */
function createMockDb() {
  const resultQueue: any[] = [];

  function createChain(): any {
    const handler: ProxyHandler<any> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: any, reject: any) => {
            const value = resultQueue.length > 0 ? resultQueue.shift() : [];
            return Promise.resolve(value).then(resolve, reject);
          };
        }
        // Any property access returns a callable that returns a new chain
        return (..._args: any[]) => createChain();
      },
    };
    return new Proxy({}, handler);
  }

  const db: any = {};

  const methods = [
    'select', 'from', 'where', 'orderBy', 'limit',
    'insert', 'values', 'returning',
    'update', 'set',
  ];

  for (const method of methods) {
    db[method] = jest.fn((..._args: any[]) => createChain());
  }

  db.transaction = jest.fn();

  db.mockResult = (value: any) => {
    resultQueue.push(value);
  };

  return db;
}

describe('WorkersService', () => {
  let service: WorkersService;
  let db: ReturnType<typeof createMockDb>;
  let orchestrator: any;

  beforeEach(async () => {
    db = createMockDb();
    orchestrator = {
      provisionWorker: jest.fn(),
      destroyWorker: jest.fn(),
      getWorkerStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: ORCHESTRATOR_TOKEN, useValue: orchestrator },
      ],
    }).compile();

    service = module.get<WorkersService>(WorkersService);
  });

  describe('findOrProvisionWorker', () => {
    it('should return existing worker when one is available', async () => {
      const existingWorker = {
        id: 'worker-1',
        internalIp: '10.0.0.1',
        apiKeyEnc: 'enc-key-123',
        currentSessions: 5,
        maxSessions: 50,
      };

      db.mockResult([existingWorker]);

      const result = await service.findOrProvisionWorker();

      expect(result).toEqual({
        id: 'worker-1',
        internalIp: '10.0.0.1',
        apiKey: 'enc-key-123',
      });
      expect(db.select).toHaveBeenCalled();
      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it('should provision a new worker when none are available', async () => {
      // No available workers
      db.mockResult([]);

      orchestrator.provisionWorker.mockResolvedValue({
        hetznerServerId: 'hetzner-99',
        internalIp: '10.0.0.99',
        apiKey: 'new-api-key',
      });

      const insertedWorker = {
        id: 'worker-new',
        internalIp: '10.0.0.99',
        apiKeyEnc: 'new-api-key',
      };
      db.mockResult([insertedWorker]);

      const result = await service.findOrProvisionWorker();

      expect(orchestrator.provisionWorker).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
      expect(result).toEqual({
        id: 'worker-new',
        internalIp: '10.0.0.99',
        apiKey: 'new-api-key',
      });
    });
  });

  describe('assignSession', () => {
    it('should call transaction with correct updates', async () => {
      let txUpdateCount = 0;

      db.transaction.mockImplementation(async (cb: any) => {
        const tx = createMockDb();
        // Track calls to tx.update
        const origUpdate = tx.update;
        tx.update = jest.fn((...args: any[]) => {
          txUpdateCount++;
          return origUpdate(...args);
        });

        await cb(tx);

        expect(tx.update).toHaveBeenCalledTimes(2);
      });

      await service.assignSession('worker-1', 'session-1');

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(txUpdateCount).toBe(2);
    });
  });

  describe('unassignSession', () => {
    it('should call transaction with correct updates', async () => {
      let txUpdateCount = 0;

      db.transaction.mockImplementation(async (cb: any) => {
        const tx = createMockDb();
        const origUpdate = tx.update;
        tx.update = jest.fn((...args: any[]) => {
          txUpdateCount++;
          return origUpdate(...args);
        });

        await cb(tx);

        expect(tx.update).toHaveBeenCalledTimes(2);
      });

      await service.unassignSession('worker-1', 'session-1');

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(txUpdateCount).toBe(2);
    });
  });

  describe('checkScaling', () => {
    it('should scale up when any worker exceeds 80% utilization', async () => {
      const highUtilWorker = {
        id: 'worker-1',
        status: 'active',
        currentSessions: 45,
        maxSessions: 50,
        internalIp: '10.0.0.1',
        apiKeyEnc: 'key',
      };

      // 1. draining workers -> []
      db.mockResult([]);
      // 2. active workers -> [highUtilWorker]
      db.mockResult([highUtilWorker]);
      // 3. findOrProvisionWorker: returns existing worker with capacity
      db.mockResult([highUtilWorker]);

      await service.checkScaling();

      // Worker has capacity, so no new provisioning
      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it('should provision new worker when no workers have capacity', async () => {
      const fullWorker = {
        id: 'worker-full',
        status: 'active',
        currentSessions: 50,
        maxSessions: 50,
      };

      // 1. draining workers -> []
      db.mockResult([]);
      // 2. active workers -> [fullWorker]
      db.mockResult([fullWorker]);
      // 3. findOrProvisionWorker: no available workers
      db.mockResult([]);
      // 4. insert new worker -> returning
      const newWorker = { id: 'worker-new', internalIp: '10.0.0.99', apiKeyEnc: 'new-key' };

      orchestrator.provisionWorker.mockResolvedValue({
        hetznerServerId: 'h-99',
        internalIp: '10.0.0.99',
        apiKey: 'new-key',
      });
      db.mockResult([newWorker]);

      await service.checkScaling();

      expect(orchestrator.provisionWorker).toHaveBeenCalled();
    });

    it('should scale down when all workers are below 30% utilization', async () => {
      const lowUtilWorkers = [
        { id: 'worker-1', status: 'active', currentSessions: 2, maxSessions: 50 },
        { id: 'worker-2', status: 'active', currentSessions: 1, maxSessions: 50 },
      ];

      // 1. draining workers -> []
      db.mockResult([]);
      // 2. active workers -> lowUtilWorkers
      db.mockResult(lowUtilWorkers);

      await service.checkScaling();

      // drainWorker should have been called (db.update is the entry point)
      expect(db.update).toHaveBeenCalled();
    });

    it('should not scale down when only one active worker', async () => {
      // 1. draining workers -> []
      db.mockResult([]);
      // 2. active workers -> [singleWorker]
      db.mockResult([
        { id: 'worker-1', status: 'active', currentSessions: 1, maxSessions: 50 },
      ]);

      await service.checkScaling();

      expect(db.update).not.toHaveBeenCalled();
    });

    it('should destroy draining workers with 0 sessions', async () => {
      const drainingWorker = {
        id: 'worker-drain',
        status: 'draining',
        currentSessions: 0,
        maxSessions: 50,
        hetznerServerId: 'hetzner-drain',
        internalIp: '10.0.0.5',
        apiKeyEnc: 'key',
      };

      // 1. draining workers -> [drainingWorker]
      db.mockResult([drainingWorker]);
      // 2. destroyWorker -> getWorker -> [drainingWorker]
      db.mockResult([drainingWorker]);
      // 3. destroyWorker -> query hetznerServerId -> [drainingWorker]
      db.mockResult([drainingWorker]);
      // 4. destroyWorker -> update status to stopped
      // 5. active workers -> []
      db.mockResult([]);

      orchestrator.destroyWorker.mockResolvedValue(undefined);

      await service.checkScaling();

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('hetzner-drain');
    });

    it('should do nothing when no active workers exist', async () => {
      // 1. draining workers -> []
      db.mockResult([]);
      // 2. active workers -> []
      db.mockResult([]);

      await service.checkScaling();

      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('destroyWorker', () => {
    it('should refuse to destroy a worker with active sessions', async () => {
      db.mockResult([{
        id: 'worker-busy',
        currentSessions: 3,
        maxSessions: 50,
        status: 'active',
        internalIp: '10.0.0.1',
        apiKeyEnc: 'key',
      }]);

      await service.destroyWorker('worker-busy');

      expect(orchestrator.destroyWorker).not.toHaveBeenCalled();
    });

    it('should call orchestrator.destroyWorker when sessions are 0', async () => {
      const worker = {
        id: 'worker-empty',
        currentSessions: 0,
        maxSessions: 50,
        status: 'draining',
        internalIp: '10.0.0.2',
        apiKeyEnc: 'key',
        hetznerServerId: 'hetzner-100',
      };

      // 1. getWorker -> [worker]
      db.mockResult([worker]);
      // 2. query hetznerServerId -> [worker]
      db.mockResult([worker]);

      orchestrator.destroyWorker.mockResolvedValue(undefined);

      await service.destroyWorker('worker-empty');

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('hetzner-100');
    });

    it('should handle worker not found', async () => {
      db.mockResult([]);

      await service.destroyWorker('nonexistent');

      expect(orchestrator.destroyWorker).not.toHaveBeenCalled();
    });
  });
});
