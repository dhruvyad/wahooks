import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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
      listReadyWorkers: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: ORCHESTRATOR_TOKEN, useValue: orchestrator },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('35') },
        },
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
        podName: 'waha-1',
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

  describe('provisionNewWorker', () => {
    it('provisions unconditionally without reusing an existing worker', async () => {
      orchestrator.provisionWorker.mockResolvedValue({
        podName: 'waha-1',
        internalIp: '10.0.0.99',
        apiKey: 'new-key',
      });
      db.mockResult([{ id: 'worker-new', internalIp: '10.0.0.99', apiKeyEnc: 'new-key' }]);

      const result = await service.provisionNewWorker();

      // No "find available worker" SELECT — goes straight to provisioning.
      expect(orchestrator.provisionWorker).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalled();
      expect(result).toEqual({ id: 'worker-new', internalIp: '10.0.0.99', apiKey: 'new-key' });
    });

    it('throws (and does not double-provision) when a provision is already in progress', async () => {
      (service as any).provisioningInProgress = true;
      await expect(service.provisionNewWorker()).rejects.toThrow('already in progress');
      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
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
    it('should not scale up when worker has available capacity', async () => {
      const worker = {
        id: 'worker-1',
        status: 'active',
        currentSessions: 45,
        maxSessions: 50,
        internalIp: '10.0.0.1',
        apiKeyEnc: 'key',
        podName: 'waha-0',
      };

      // 1. active workers (first fetch)
      db.mockResult([worker]);
      // 2. reconcile: count -> 45
      db.mockResult([{ count: 45 }]);
      // 3. re-fetch active workers
      db.mockResult([worker]);
      // 4. draining workers -> []
      db.mockResult([]);

      await service.checkScaling();

      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it('proactively pre-warms a new worker when free slots drop to the threshold', async () => {
      // 49/50 → 1 slot free (<= 10 proactive threshold, but > 0): should pre-warm.
      const worker = {
        id: 'worker-1', status: 'active', currentSessions: 49, maxSessions: 50,
        internalIp: '10.0.0.1', apiKeyEnc: 'key', podName: 'waha-0',
      };
      db.mockResult([worker]);        // active workers
      db.mockResult([{ count: 49 }]); // reconcile count
      db.mockResult([]);              // reconcile update (ignored)
      db.mockResult([worker]);        // re-fetch active
      db.mockResult([]);              // draining
      orchestrator.provisionWorker.mockResolvedValue({
        podName: 'waha-1', internalIp: '10.0.0.2', apiKey: 'k2',
      });
      db.mockResult([{ id: 'worker-2', internalIp: '10.0.0.2', apiKeyEnc: 'k2' }]); // insert

      await service.checkScaling();

      // The bug was that proactive routed through findOrProvisionWorker, which
      // returned the 49/50 worker (still "available") and never provisioned.
      expect(orchestrator.provisionWorker).toHaveBeenCalledTimes(1);
    });

    it('should provision new worker when no workers have capacity', async () => {
      // Test findOrProvisionWorker directly since checkScaling has complex mock requirements
      db.mockResult([]); // no available workers
      orchestrator.provisionWorker.mockResolvedValue({
        podName: 'waha-1',
        internalIp: '10.0.0.99',
        apiKey: 'new-key',
      });
      db.mockResult([{ id: 'worker-new', internalIp: '10.0.0.99', apiKeyEnc: 'new-key' }]);

      const result = await service.findOrProvisionWorker();

      expect(orchestrator.provisionWorker).toHaveBeenCalled();
      expect(result.internalIp).toBe('10.0.0.99');
    });

    it('should scale down when all workers are below 30% utilization', async () => {
      const lowUtilWorkers = [
        { id: 'worker-1', status: 'active', currentSessions: 2, maxSessions: 50, podName: 'waha-0' },
        { id: 'worker-2', status: 'active', currentSessions: 1, maxSessions: 50, podName: 'waha-1' },
      ];

      // 1. active workers
      db.mockResult(lowUtilWorkers);
      // 2-3. reconcile worker-1: count + update
      db.mockResult([{ count: 2 }]);
      // 4-5. reconcile worker-2: count + update
      db.mockResult([{ count: 1 }]);
      // 6. re-fetch active workers
      db.mockResult(lowUtilWorkers);
      // 7. draining workers -> []
      db.mockResult([]);

      await service.checkScaling();

      // drainWorker should have been called (db.update)
      expect(db.update).toHaveBeenCalled();
    });

    it('should not scale down when only one active worker', async () => {
      const singleWorker = { id: 'worker-1', status: 'active', currentSessions: 1, maxSessions: 50, podName: 'waha-0' };

      // 1. active workers
      db.mockResult([singleWorker]);
      // 2. reconcile: count
      db.mockResult([{ count: 1 }]);
      // 3. re-fetch active workers
      db.mockResult([singleWorker]);
      // 4. draining workers -> []
      db.mockResult([]);

      await service.checkScaling();

      // No scale-down with 1 worker
      expect(orchestrator.destroyWorker).not.toHaveBeenCalled();
    });

    it('should destroy draining workers with 0 sessions', async () => {
      // Test destroyWorker directly
      const worker = {
        id: 'worker-drain',
        currentSessions: 0,
        maxSessions: 50,
        status: 'draining',
        internalIp: '10.0.0.5',
        apiKeyEnc: 'key',
        podName: 'waha-0',
      };

      // getWorker
      db.mockResult([worker]);

      orchestrator.destroyWorker.mockResolvedValue(true);

      await service.destroyWorker('worker-drain');

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('waha-0');
    });

    it('should do nothing when no active workers exist', async () => {
      // 1. active workers -> []
      db.mockResult([]);
      // 2. re-fetch active workers -> []
      db.mockResult([]);
      // 3. draining workers -> []
      db.mockResult([]);

      await service.checkScaling();

      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
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
        podName: 'waha-0',
      };

      // 1. getWorker -> [worker]
      db.mockResult([worker]);

      orchestrator.destroyWorker.mockResolvedValue(true);

      await service.destroyWorker('worker-empty');

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('waha-0');
      expect(db.update).toHaveBeenCalledTimes(1); // marked stopped
    });

    it('keeps a worker draining when the orchestrator keeps its pod', async () => {
      db.mockResult([{
        id: 'worker-kept', currentSessions: 0, maxSessions: 35, status: 'draining',
        internalIp: 'waha-1.waha', apiKeyEnc: 'key', podName: 'waha-1',
      }]);
      orchestrator.destroyWorker.mockResolvedValue(false);

      await service.destroyWorker('worker-kept');

      // Marking it stopped would strand a running pod (and adoption would revive it).
      expect(db.update).not.toHaveBeenCalled();
    });

    it('keeps a worker draining when destroying its pod fails', async () => {
      db.mockResult([{
        id: 'worker-err', currentSessions: 0, maxSessions: 35, status: 'draining',
        internalIp: 'waha-1.waha', apiKeyEnc: 'key', podName: 'waha-1',
      }]);
      orchestrator.destroyWorker.mockRejectedValue(new Error('k8s API down'));

      await service.destroyWorker('worker-err');

      expect(db.update).not.toHaveBeenCalled();
    });

    it('should handle worker not found', async () => {
      db.mockResult([]);

      await service.destroyWorker('nonexistent');

      expect(orchestrator.destroyWorker).not.toHaveBeenCalled();
    });
  });

  describe('adopting ready pods', () => {
    // Records each insert chain so the upserted values can be asserted.
    function recordInserts() {
      const calls: Array<{ values?: any; onConflict?: any }> = [];
      db.insert = jest.fn(() => {
        const call: { values?: any; onConflict?: any } = {};
        calls.push(call);
        const chain: any = {
          values: (v: any) => ((call.values = v), chain),
          onConflictDoUpdate: (c: any) => ((call.onConflict = c), chain),
          returning: async () => [{
            id: `row-${call.values.podName}`,
            internalIp: call.values.internalIp,
            apiKeyEnc: call.values.apiKeyEnc,
          }],
        };
        return chain;
      });
      return calls;
    }
    const pod = (n: number) => ({
      podName: `waha-${n}`,
      internalIp: `waha-${n}.waha.default.svc.cluster.local`,
      apiKey: 'waha-key',
    });

    it('registers every ready pod whose row is missing or stopped, with today\'s session cap', async () => {
      orchestrator.listReadyWorkers.mockResolvedValue([pod(0), pod(1), pod(2), pod(3)]);
      db.mockResult([
        { podName: 'waha-0', status: 'active' },
        { podName: 'waha-1', status: 'draining' },
        { podName: 'waha-2', status: 'stopped' },
      ]);
      const inserts = recordInserts();

      const adopted = await service.adoptReadyWorkers();

      // waha-0 is already in use and waha-1 is being emptied on purpose.
      expect(inserts.map((c) => c.values.podName)).toEqual(['waha-2', 'waha-3']);
      for (const call of inserts) {
        expect(call.values).toMatchObject({ status: 'active', maxSessions: 35 });
        // A revived row (waha-2 had a stale cap of 50) takes the configured cap.
        expect(call.onConflict.set).toMatchObject({ status: 'active', currentSessions: 0, maxSessions: 35 });
      }
      expect(adopted.map((w) => w.id)).toEqual(['row-waha-2', 'row-waha-3']);
    });

    it('adopts an idle ready pod instead of asking the orchestrator for a new one', async () => {
      orchestrator.listReadyWorkers.mockResolvedValue([pod(0), pod(2)]);
      db.mockResult([{ podName: 'waha-0', status: 'active' }]);
      recordInserts();

      const worker = await service.provisionNewWorker();

      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
      expect(worker).toEqual({ id: 'row-waha-2', internalIp: pod(2).internalIp, apiKey: 'waha-key' });
    });

    it('adopts before judging capacity on every scaling check', async () => {
      orchestrator.listReadyWorkers.mockResolvedValue([pod(2)]);
      db.mockResult([{ podName: 'waha-2', status: 'stopped' }]);
      const inserts = recordInserts();

      await service.checkScaling();

      expect(inserts.map((c) => c.values.podName)).toEqual(['waha-2']);
    });
  });

  describe('scale-up failures', () => {
    const blocked = new Error(
      "Pod waha-3 can't be scheduled (3 Insufficient cpu) and the cluster autoscaler can't add a node: workers: Primary IP limit exceeded (resource_limit_exceeded)",
    );

    it('records why scale-ups keep failing, and clears it once one succeeds', async () => {
      const errorLog = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      orchestrator.provisionWorker.mockRejectedValue(blocked);

      await expect(service.provisionNewWorker()).rejects.toThrow('Primary IP limit exceeded');
      const first = service.getScaleUpFailure();
      expect(first).toMatchObject({ reason: blocked.message, failedAttempts: 1 });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Primary IP limit exceeded'));

      await expect(service.provisionNewWorker()).rejects.toThrow();
      expect(service.getScaleUpFailure()).toMatchObject({ failedAttempts: 2, since: first!.since });

      orchestrator.provisionWorker.mockResolvedValue({
        podName: 'waha-3', internalIp: 'waha-3.waha', apiKey: 'k',
      });
      db.mockResult([{ id: 'w3', internalIp: 'waha-3.waha', apiKeyEnc: 'k' }]);
      await service.provisionNewWorker();
      expect(service.getScaleUpFailure()).toBeNull();
    });

    it('records the failure when a scaling check cannot add a worker', async () => {
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      const full = { id: 'w0', status: 'active', currentSessions: 35, maxSessions: 35, podName: 'waha-0' };
      db.mockResult([full]);            // active workers
      db.mockResult([{ count: 35 }]);   // reconcile count
      db.mockResult([]);                // reconcile update
      db.mockResult([full]);            // re-fetch active
      db.mockResult([]);                // draining
      db.mockResult([{ id: 'pending-1' }]); // workerless pending sessions
      db.mockResult([]);                // findOrProvisionWorker: no worker with room
      orchestrator.provisionWorker.mockRejectedValue(blocked);

      await service.checkScaling();

      expect(service.getScaleUpFailure()?.reason).toContain('Primary IP limit exceeded');
    });
  });

  describe('scale-down target', () => {
    const w0 = { id: 'w0', status: 'active', currentSessions: 1, maxSessions: 35, podName: 'waha-0' };
    const w2 = { id: 'w2', status: 'active', currentSessions: 1, maxSessions: 35, podName: 'waha-2' };
    function queueUnderThreshold(highestWorking: number) {
      db.mockResult([w0, w2]);          // active workers
      db.mockResult([{ count: 1 }]);    // reconcile w0 count
      db.mockResult([]);                // reconcile w0 update
      db.mockResult([{ count: 1 }]);    // reconcile w2 count
      db.mockResult([]);                // reconcile w2 update
      db.mockResult([w0, w2]);          // re-fetch active
      db.mockResult([]);                // draining
      db.mockResult([{ count: highestWorking }]); // working sessions on waha-2
    }

    it('never drains a lower-ordinal worker the StatefulSet cannot remove', async () => {
      queueUnderThreshold(1);

      await service.checkScaling();

      // Only the two reconcile updates: waha-2 has a live session, and waha-0
      // can't leave the StatefulSet while waha-2 exists.
      expect(db.update).toHaveBeenCalledTimes(2);
    });

    it('drains the highest-ordinal worker when it holds no working session', async () => {
      queueUnderThreshold(0);

      await service.checkScaling();

      // Reconcile ×2, stop its idle sessions, re-reconcile (count + update), mark draining.
      expect(db.update).toHaveBeenCalledTimes(5);
    });
  });
});
