import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WorkersService, gatewayScaleDecision } from './workers.service';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WORKER_ORCHESTRATORS_TOKEN } from '../orchestration/orchestrator.interface';

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
  db.shift = () => (resultQueue.length > 0 ? resultQueue.shift() : []);

  return db;
}

/** The SQL text and parameters of a drizzle condition. */
function sqlOf(condition: any): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition);
}

describe('WorkersService', () => {
  let service: WorkersService;
  let db: ReturnType<typeof createMockDb>;
  let orchestrator: any;
  let gatewayOrchestrator: any;

  const mockOrchestrator = () => ({
    provisionWorker: jest.fn(),
    destroyWorker: jest.fn(),
    getWorkerStatus: jest.fn(),
    listReadyWorkers: jest.fn().mockResolvedValue([]),
  });

  /** A service over a fresh mock DB with this env (and gateway orchestrator, if any). */
  async function build(env: Record<string, string> = {}, gateway: any = null) {
    db = createMockDb();
    orchestrator = mockOrchestrator();
    gatewayOrchestrator = gateway;
    const values: Record<string, string> = { WAHA_MAX_SESSIONS: '35', ...env };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: WORKER_ORCHESTRATORS_TOKEN, useValue: { waha: orchestrator, gateway } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, def?: unknown) => (key in values ? values[key] : def)) },
        },
      ],
    }).compile();

    service = module.get<WorkersService>(WorkersService);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
  }

  beforeEach(async () => {
    await build();
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
        kind: 'waha',
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
        kind: 'waha',
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
      expect(result).toEqual({ id: 'worker-new', internalIp: '10.0.0.99', apiKey: 'new-key', kind: 'waha' });
    });

    it('throws (and does not double-provision) when a provision is already in progress', async () => {
      (service as any).provisioning.waha = true;
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

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('waha-0', { allowLast: false });
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

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('waha-0', { allowLast: false });
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
        expect(call.values).toMatchObject({ status: 'active', kind: 'waha', maxSessions: 35 });
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
      expect(worker).toEqual({ id: 'row-waha-2', internalIp: pod(2).internalIp, apiKey: 'waha-key', kind: 'waha' });
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

  // ---- Worker kinds ----

  /** Records each insert/update chain's arguments; awaiting one takes the next queued result. */
  function record(method: 'insert' | 'update') {
    const calls: Array<Record<string, any>> = [];
    db[method] = jest.fn((table: unknown) => {
      const call: Record<string, any> = { table };
      calls.push(call);
      const chain: any = new Proxy(
        {},
        {
          get(_target, prop: string) {
            if (prop === 'then') {
              return (resolve: any, reject: any) => Promise.resolve(db.shift()).then(resolve, reject);
            }
            return (arg: unknown) => ((call[prop] = arg), chain);
          },
        },
      );
      return chain;
    });
    return calls;
  }

  /** Records the condition of every select's where(); results come from the queue. */
  function recordSelectWheres() {
    const wheres: any[] = [];
    db.select = jest.fn(() => {
      const chain: any = new Proxy(
        {},
        {
          get(_target, prop: string) {
            if (prop === 'then') {
              return (resolve: any, reject: any) => Promise.resolve(db.shift()).then(resolve, reject);
            }
            return (arg: unknown) => {
              if (prop === 'where') wheres.push(arg);
              return chain;
            };
          },
        },
      );
      return chain;
    });
    return wheres;
  }

  /** Queue what checkScaling reads before deciding: active rows, their reconciles, no draining rows. */
  function queueScalingCheck(active: any[], draining: any[] = []) {
    db.mockResult(active); // active workers
    for (const w of active) {
      db.mockResult([{ count: w.currentSessions }]); // reconcile count
      db.mockResult([]); // reconcile update
    }
    db.mockResult(active); // re-fetch active
    db.mockResult(draining); // draining workers
  }

  const gatewayBox = (over: Record<string, unknown> = {}) => ({
    id: 'gw-1', podName: 'wagw-0a1b2c3d', internalIp: '10.0.1.5', apiKeyEnc: 'gateway-test-key',
    status: 'active', kind: 'gateway', currentSessions: 0, maxSessions: 5000, ...over,
  });
  const wahaPod = (n: number, current: number, over: Record<string, unknown> = {}) => ({
    id: `w${n}`, podName: `waha-${n}`, internalIp: `waha-${n}.waha`, apiKeyEnc: 'waha-key',
    status: 'active', kind: 'waha', currentSessions: current, maxSessions: 35, ...over,
  });

  describe('placement by kind', () => {
    it('places new connections on WAHA by default, never on a gateway', async () => {
      const wheres = recordSelectWheres();
      db.mockResult([wahaPod(0, 3)]);

      const worker = await service.findOrProvisionWorker();

      expect(service.newConnectionKind).toBe('waha');
      expect(worker).toMatchObject({ id: 'w0', kind: 'waha' });
      expect(sqlOf(wheres[0]).sql).toContain('"kind" = $');
      expect(sqlOf(wheres[0]).params).toEqual(['active', 'waha']);
    });

    it('places new connections on the least-loaded gateway with room when NEW_CONNECTION_WORKER_KIND=gateway', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, mockOrchestrator());
      const wheres = recordSelectWheres();
      db.mockResult([gatewayBox({ currentSessions: 10 })]);

      const worker = await service.findOrProvisionWorker();

      expect(worker).toEqual({ id: 'gw-1', internalIp: '10.0.1.5', apiKey: 'gateway-test-key', kind: 'gateway' });
      expect(sqlOf(wheres[0]).params).toEqual(['active', 'gateway']);
      // "with room": current_sessions < max_sessions, so a pinned max-0 row never qualifies.
      expect(sqlOf(wheres[0]).sql).toMatch(/"current_sessions" < "waha_workers"\."max_sessions"/);
    });

    it('provisions a gateway box when none has room: its key is recorded before the wait, its cap is GATEWAY_MAX_SESSIONS', async () => {
      const gw = mockOrchestrator();
      const box = { podName: 'wagw-1a2b3c4d', internalIp: '10.0.1.9', apiKey: 'gateway-test-key' };
      gw.provisionWorker.mockImplementation(async (hooks: any) => {
        await hooks.onCreated(box);
        return box;
      });
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway', GATEWAY_MAX_SESSIONS: '2' }, gw);
      const inserts = record('insert');
      db.mockResult([]); // no gateway with room
      db.mockResult(undefined); // provisioning row
      db.mockResult([{ id: 'gw-new', internalIp: box.internalIp, apiKeyEnc: box.apiKey, kind: 'gateway' }]);

      const worker = await service.findOrProvisionWorker();

      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
      expect(gw.provisionWorker).toHaveBeenCalledTimes(1);
      expect(inserts[0].values).toMatchObject({
        podName: box.podName, internalIp: box.internalIp, apiKeyEnc: box.apiKey,
        status: 'provisioning', kind: 'gateway', maxSessions: 2,
      });
      expect(inserts[1].values).toMatchObject({ podName: box.podName, status: 'active', kind: 'gateway', maxSessions: 2 });
      expect(inserts[1].onConflictDoUpdate.set).toMatchObject({ status: 'active', kind: 'gateway', maxSessions: 2 });
      expect(worker).toEqual({ id: 'gw-new', internalIp: box.internalIp, apiKey: box.apiKey, kind: 'gateway' });
    });

    it('fails, and says why on /api/health, when gateways take new connections but none can be provisioned', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, null);
      db.mockResult([]); // no gateway with room

      await expect(service.findOrProvisionWorker()).rejects.toThrow('No orchestrator for gateway workers');
      expect(service.getScaleUpFailure()).toMatchObject({ kind: 'gateway', failedAttempts: 1 });
      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it("falls back to WAHA for a NEW_CONNECTION_WORKER_KIND it doesn't know", async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gatway' });
      expect(service.newConnectionKind).toBe('waha');
    });
  });

  describe('per-kind scaling', () => {
    it('no longer lets a pinned gateway row (max_sessions 0) block WAHA scale-down', async () => {
      const pinned = gatewayBox({ id: 'gw-a', podName: 'wagw-a', currentSessions: 1, maxSessions: 0 });
      queueScalingCheck([wahaPod(0, 1), wahaPod(2, 1), pinned]);
      db.mockResult([{ count: 0 }]); // working sessions on waha-2
      const drain = jest.spyOn(service, 'drainWorker');

      await service.checkScaling();

      expect(drain).toHaveBeenCalledWith('w2');
      // Not a gateway scale-up either: the pinned row counts for no room and no load.
      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it.each([
      [4, 5, true], // 80 %: at the default GATEWAY_SCALE_UP_AT
      [3, 5, false], // 60 %
    ])('with %i/%i gateway sessions, provisions a box: %s', async (current, max, provisions) => {
      const gw = mockOrchestrator();
      gw.provisionWorker.mockResolvedValue({ podName: 'wagw-new', internalIp: '10.0.1.6', apiKey: 'gateway-test-key' });
      await build({}, gw);
      queueScalingCheck([gatewayBox({ currentSessions: current, maxSessions: max })]);
      db.mockResult([{ id: 'gw-2', internalIp: '10.0.1.6', apiKeyEnc: 'gateway-test-key', kind: 'gateway' }]);

      await service.checkScaling();

      expect(gw.provisionWorker).toHaveBeenCalledTimes(provisions ? 1 : 0);
      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it('honours GATEWAY_SCALE_UP_AT', async () => {
      const gw = mockOrchestrator();
      await build({ GATEWAY_SCALE_UP_AT: '0.5' }, gw);
      gw.provisionWorker.mockResolvedValue({ podName: 'wagw-new', internalIp: '10.0.1.6', apiKey: 'gateway-test-key' });
      queueScalingCheck([gatewayBox({ currentSessions: 3, maxSessions: 6 })]);

      await service.checkScaling();

      expect(gw.provisionWorker).toHaveBeenCalledTimes(1);
    });

    it('with a small GATEWAY_MAX_SESSIONS, a box registers with that cap and filling it adds the next box', async () => {
      const gw = mockOrchestrator();
      gw.provisionWorker.mockResolvedValue({ podName: 'wagw-0002', internalIp: '10.0.1.7', apiKey: 'gateway-test-key' });
      await build({ GATEWAY_MAX_SESSIONS: '2', NEW_CONNECTION_WORKER_KIND: 'gateway' }, gw);
      const inserts = record('insert');
      queueScalingCheck([gatewayBox({ podName: 'wagw-0001', currentSessions: 2, maxSessions: 2 })]);
      db.mockResult([{ id: 'gw-2', internalIp: '10.0.1.7', apiKeyEnc: 'gateway-test-key', kind: 'gateway' }]);

      await service.checkScaling();

      expect(gw.provisionWorker).toHaveBeenCalledTimes(1);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].values).toMatchObject({ podName: 'wagw-0002', kind: 'gateway', status: 'active', maxSessions: 2 });
    });

    it('never provisions two gateway boxes at once', async () => {
      let finish!: (r: any) => void;
      const gw = mockOrchestrator();
      gw.provisionWorker.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      await build({}, gw);

      const first = service.provisionNewWorker('gateway');
      await expect(service.provisionNewWorker('gateway')).rejects.toThrow('already in progress');

      // A scaling check meanwhile sees a full fleet but leaves the box in flight alone.
      queueScalingCheck([gatewayBox({ currentSessions: 5000 })]);
      await service.checkScaling();
      expect(gw.provisionWorker).toHaveBeenCalledTimes(1);

      // A WAHA pod can still be added alongside.
      orchestrator.provisionWorker.mockResolvedValue({ podName: 'waha-1', internalIp: 'waha-1.waha', apiKey: 'waha-key' });
      db.mockResult([{ id: 'w1', internalIp: 'waha-1.waha', apiKeyEnc: 'waha-key', kind: 'waha' }]);
      await expect(service.provisionNewWorker('waha')).resolves.toMatchObject({ id: 'w1' });

      db.mockResult([{ id: 'gw-2', internalIp: '10.0.1.6', apiKeyEnc: 'gateway-test-key', kind: 'gateway' }]);
      finish({ podName: 'wagw-new', internalIp: '10.0.1.6', apiKey: 'gateway-test-key' });
      await expect(first).resolves.toMatchObject({ id: 'gw-2', kind: 'gateway' });
      expect(service.getScaleUpFailure()).toBeNull();
    });

    it('adds no WAHA pod while new connections go to gateways, however full WAHA is', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, null);
      queueScalingCheck([wahaPod(0, 35)]);
      db.mockResult([{ count: 35 }]); // sessions still on WAHA: not going to zero

      await service.checkScaling();

      expect(orchestrator.provisionWorker).not.toHaveBeenCalled();
    });

    it('logs instead of scaling a gateway fleet nobody can provision for', async () => {
      await build({}, null);
      queueScalingCheck([gatewayBox({ currentSessions: 4900 })]);

      await service.checkScaling();

      expect((service as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('no gateway orchestrator'));
      expect(service.getScaleUpFailure()).toBeNull();
    });
  });

  describe('gatewayScaleDecision', () => {
    it('ignores pinned (max 0) rows for load and room', () => {
      expect(gatewayScaleDecision([{ currentSessions: 1, maxSessions: 0 }, { currentSessions: 3, maxSessions: 10 }], 0.8, false))
        .toEqual({ scaleUp: false, used: 3, capacity: 10, ratio: 0.3 });
    });

    it('wants a box with no gateway room only while new connections go to gateways', () => {
      expect(gatewayScaleDecision([{ currentSessions: 1, maxSessions: 0 }], 0.8, false).scaleUp).toBe(false);
      expect(gatewayScaleDecision([{ currentSessions: 1, maxSessions: 0 }], 0.8, true).scaleUp).toBe(true);
      expect(gatewayScaleDecision([], 0.8, true).scaleUp).toBe(true);
      expect(gatewayScaleDecision([], 0.8, false).scaleUp).toBe(false);
    });
  });

  describe('WAHA to zero', () => {
    it('drains the highest-ordinal WAHA pod once new connections go to gateways and no WAHA session is left', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, null);
      const wheres = recordSelectWheres();
      queueScalingCheck([wahaPod(0, 0), wahaPod(1, 0)]);
      db.mockResult([{ count: 0 }]); // non-stopped sessions on WAHA workers
      const drain = jest.spyOn(service, 'drainWorker');

      await service.checkScaling();

      expect(drain).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenCalledWith('w1');
      // Counted over WAHA workers that still exist, every non-stopped session (failed too).
      const count = sqlOf(wheres[wheres.length - 1]);
      expect(count.params).toEqual(['waha', 'stopped', 'stopped']);
    });

    it('drains the last WAHA pod too, and lets the orchestrator remove it', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, null);
      const last = wahaPod(0, 0, { status: 'draining' });
      queueScalingCheck([], [last]);
      db.mockResult([{ count: 0 }]); // reconcile count
      db.mockResult([]); // reconcile update
      db.mockResult([last]); // getWorker
      db.mockResult([{ count: 0 }]); // no WAHA session left
      db.mockResult([last]); // destroyWorker → getWorker
      orchestrator.destroyWorker.mockResolvedValue(true);

      await service.checkScaling();

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('waha-0', { allowLast: true });
    });

    it('keeps the last WAHA pod while any WAHA worker holds a session', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, null);
      const last = wahaPod(0, 0, { status: 'draining' });
      queueScalingCheck([], [last]);
      db.mockResult([{ count: 0 }]);
      db.mockResult([]);
      db.mockResult([last]);
      db.mockResult([{ count: 1 }]); // a failed session still on a WAHA worker
      db.mockResult([last]);
      orchestrator.destroyWorker.mockResolvedValue(false);

      await service.checkScaling();

      expect(orchestrator.destroyWorker).toHaveBeenCalledWith('waha-0', { allowLast: false });
    });

    it('waits for every WAHA session to move before draining the last pod', async () => {
      await build({ NEW_CONNECTION_WORKER_KIND: 'gateway' }, null);
      queueScalingCheck([wahaPod(0, 0)]);
      db.mockResult([{ count: 1 }]);
      const drain = jest.spyOn(service, 'drainWorker');

      await service.checkScaling();

      expect(drain).not.toHaveBeenCalled();
    });

    it('never goes to zero while new connections are placed on WAHA', async () => {
      queueScalingCheck([wahaPod(0, 0)]);
      const drain = jest.spyOn(service, 'drainWorker');

      await service.checkScaling();

      expect(drain).not.toHaveBeenCalled();
    });

    it('never destroys a drained gateway box (removing one is a human decision)', async () => {
      const gw = mockOrchestrator();
      await build({}, gw);
      const drained = gatewayBox({ status: 'draining' });
      queueScalingCheck([], [drained]);
      db.mockResult([{ count: 0 }]);
      db.mockResult([]);
      db.mockResult([drained]); // getWorker
      const updates = record('update');

      await service.checkScaling();

      expect(gw.destroyWorker).not.toHaveBeenCalled();
      expect(updates.some((u) => u.set?.status === 'stopped')).toBe(false);
    });
  });

  describe('adopting gateway boxes', () => {
    const handMade = { id: 'gw-a', podName: 'wagw-a', internalIp: '10.255.0.250', apiKeyEnc: 'hand-key' };

    it('matches a box registered by hand under another name by its address, and never registers it twice', async () => {
      const gw = mockOrchestrator();
      gw.listReadyWorkers.mockResolvedValue([{ podName: 'wahooks-gw-1', internalIp: '10.255.0.250', apiKey: '' }]);
      await build({}, gw);
      const wheres = recordSelectWheres();
      db.mockResult([{ ...handMade, status: 'active' }]);
      const inserts = record('insert');
      const updates = record('update');

      await expect(service.adoptReadyWorkers('gateway')).resolves.toEqual([]);

      expect(inserts).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(sqlOf(wheres[0]).params).toEqual(['wahooks-gw-1', '10.255.0.250']);
    });

    it('revives a stopped hand-made row in place, keeping its name and key', async () => {
      const gw = mockOrchestrator();
      gw.listReadyWorkers.mockResolvedValue([{ podName: 'wahooks-gw-1', internalIp: '10.255.0.250', apiKey: '' }]);
      await build({}, gw);
      db.mockResult([{ ...handMade, status: 'stopped' }]);
      db.mockResult([{ ...handMade, kind: 'gateway', status: 'active' }]);
      const inserts = record('insert');
      const updates = record('update');

      const [worker] = await service.adoptReadyWorkers('gateway');

      expect(inserts).toHaveLength(0);
      expect(updates).toHaveLength(1);
      expect(updates[0].set).toMatchObject({ status: 'active', kind: 'gateway', apiKeyEnc: 'hand-key' });
      expect(updates[0].set).not.toHaveProperty('podName');
      expect(worker).toEqual({ id: 'gw-a', internalIp: '10.255.0.250', apiKey: 'hand-key', kind: 'gateway' });
    });

    it('activates a box whose provision timed out with the key its provisioning row kept', async () => {
      const gw = mockOrchestrator();
      gw.listReadyWorkers.mockResolvedValue([{ podName: 'wagw-1234abcd', internalIp: '10.0.1.7', apiKey: '' }]);
      await build({}, gw);
      db.mockResult([{ id: 'row-p', podName: 'wagw-1234abcd', internalIp: '10.0.1.7', status: 'provisioning', apiKeyEnc: 'kept-test-key' }]);
      db.mockResult([{ id: 'row-p', internalIp: '10.0.1.7', apiKeyEnc: 'kept-test-key', kind: 'gateway' }]);
      const inserts = record('insert');

      await service.adoptReadyWorkers('gateway');

      expect(inserts[0].values).toMatchObject({ podName: 'wagw-1234abcd', apiKeyEnc: 'kept-test-key', status: 'active', kind: 'gateway' });
    });

    it("leaves a ready box without a row alone: its key isn't known", async () => {
      const gw = mockOrchestrator();
      gw.listReadyWorkers.mockResolvedValue([{ podName: 'wagw-ffff0000', internalIp: '10.0.1.8', apiKey: '' }]);
      await build({}, gw);
      db.mockResult([]);
      const inserts = record('insert');

      await expect(service.adoptReadyWorkers('gateway')).resolves.toEqual([]);
      expect(inserts).toHaveLength(0);
    });
  });

  describe('getWorkerKind', () => {
    afterEach(() => jest.restoreAllMocks());

    it('answers from a cache: one query for a burst of events, refreshed after a minute', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      db.mockResult([{ id: 'w0', kind: 'waha' }, { id: 'gw-1', kind: 'gateway' }]);

      const kinds = await Promise.all(['gw-1', 'w0', 'gw-1', 'w0'].map((id) => service.getWorkerKind(id)));

      expect(kinds).toEqual(['gateway', 'waha', 'gateway', 'waha']);
      expect(db.select).toHaveBeenCalledTimes(1);
      // An id it doesn't know, right after a load: no query.
      await expect(service.getWorkerKind('nope')).resolves.toBeNull();
      expect(db.select).toHaveBeenCalledTimes(1);

      jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + 61_000);
      db.mockResult([{ id: 'gw-1', kind: 'gateway' }]);
      await service.getWorkerKind('gw-1');
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('gateway reachability', () => {
    it('remembers since when a box has been unreachable', () => {
      service.recordGatewayHealth([{ id: 'gw-1', podName: 'wagw-a', reachable: false }]);
      const since = service.getGatewayHealth()!.boxes[0].unreachableSince;
      service.recordGatewayHealth([{ id: 'gw-1', podName: 'wagw-a', reachable: false }]);
      expect(service.getGatewayHealth()!.boxes[0].unreachableSince).toBe(since);
      service.recordGatewayHealth([{ id: 'gw-1', podName: 'wagw-a', reachable: true }]);
      expect(service.getGatewayHealth()!.boxes[0].unreachableSince).toBeNull();
    });
  });
});
