import { K8sOrchestrator } from './k8s.orchestrator';

// The autoscaler's status ConfigMap as the live cluster wrote it (trimmed).
const BACKOFF_STATUS = `time: 2026-10-21 22:15:32.543519292 +0000 UTC
autoscalerStatus: Running
nodeGroups:
- name: wahooks-waha-workers
  health:
    status: Healthy
  scaleUp:
    status: Backoff
    backoffInfo:
      errorCode: cloudProviderError
      errorMessage: 'failed to increase node group size: failed to create all servers:
        could not create server type cx23 in region nbg1: Primary IP limit exceeded
        (resource_limit_exceeded)'
    lastProbeTime: "2026-10-21T22:15:32.543519292Z"
`;
const SCALING_STATUS = BACKOFF_STATUS.replace(/status: Backoff[\s\S]*?\)'\n/, 'status: InProgress\n');

const UNSCHEDULABLE = '0/4 nodes are available: 3 Insufficient cpu, 3 Insufficient memory.';

const readyPod = { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
const pendingPod = {
  status: {
    phase: 'Pending',
    conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: UNSCHEDULABLE }],
  },
};

describe('K8sOrchestrator', () => {
  let orchestrator: K8sOrchestrator;
  let appsV1: { readNamespacedStatefulSet: jest.Mock; patchNamespacedStatefulSet: jest.Mock };
  let coreV1: { readNamespacedPod: jest.Mock; readNamespacedConfigMap: jest.Mock };

  function cluster(replicas: number, pods: Record<string, any>, autoscalerStatus?: string | Error) {
    appsV1.readNamespacedStatefulSet.mockResolvedValue({ body: { spec: { replicas } } });
    coreV1.readNamespacedPod.mockImplementation(async (name: string) => {
      if (!pods[name]) throw new Error(`pods "${name}" not found`);
      return { body: pods[name] };
    });
    coreV1.readNamespacedConfigMap.mockImplementation(async () => {
      if (autoscalerStatus instanceof Error) throw autoscalerStatus;
      return { body: { data: { status: autoscalerStatus ?? '' } } };
    });
  }

  beforeEach(() => {
    orchestrator = new K8sOrchestrator({
      get: (_key: string, def?: string) => def,
      getOrThrow: () => 'waha-key',
    } as any);
    appsV1 = { readNamespacedStatefulSet: jest.fn(), patchNamespacedStatefulSet: jest.fn() };
    coreV1 = { readNamespacedPod: jest.fn(), readNamespacedConfigMap: jest.fn() };
    Object.assign(orchestrator as any, { appsV1, coreV1 });
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn((orchestrator as any).logger, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.useRealTimers());

  describe('listReadyWorkers', () => {
    it('lists every ready pod, not just the highest-numbered one', async () => {
      cluster(4, { 'waha-0': readyPod, 'waha-1': readyPod, 'waha-2': readyPod, 'waha-3': pendingPod });

      const ready = await orchestrator.listReadyWorkers();

      expect(ready).toEqual(
        [0, 1, 2].map((n) => ({
          podName: `waha-${n}`,
          internalIp: `waha-${n}.waha.default.svc.cluster.local`,
          apiKey: 'waha-key',
        })),
      );
    });
  });

  describe('provisionWorker', () => {
    it("fails at once, with the cloud's reason, when the autoscaler can't add a node", async () => {
      cluster(4, { 'waha-2': readyPod, 'waha-3': pendingPod }, BACKOFF_STATUS);

      const error = await orchestrator.provisionWorker().catch((e: Error) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Primary IP limit exceeded (resource_limit_exceeded)');
      expect((error as Error).message).toContain(UNSCHEDULABLE);
      expect(appsV1.patchNamespacedStatefulSet).not.toHaveBeenCalled();
    });

    it('keeps waiting while the autoscaler is still adding a node', async () => {
      jest.useFakeTimers();
      const pods: Record<string, any> = { 'waha-3': pendingPod };
      cluster(4, pods, SCALING_STATUS);

      const provisioned = orchestrator.provisionWorker();
      await jest.advanceTimersByTimeAsync(6_000);
      pods['waha-3'] = readyPod;
      await jest.advanceTimersByTimeAsync(3_000);

      await expect(provisioned).resolves.toMatchObject({ podName: 'waha-3' });
    });

    it("waits out the timeout, naming why the pod can't run, when the autoscaler's status is unreadable", async () => {
      jest.useFakeTimers();
      cluster(4, { 'waha-3': pendingPod }, new Error('configmaps "cluster-autoscaler-status" is forbidden'));

      const provisioned = orchestrator.provisionWorker().catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(301_000);
      const error = (await provisioned) as Error;

      expect(error.message).toContain('did not become Ready within 300s');
      expect(error.message).toContain(UNSCHEDULABLE);
      // Read once; a 403 isn't retried every poll.
      expect(coreV1.readNamespacedConfigMap).toHaveBeenCalledTimes(1);
    });
  });

  describe('destroyWorker', () => {
    it('reports a pod it kept because a higher ordinal still exists', async () => {
      cluster(4, {});

      await expect(orchestrator.destroyWorker('waha-2')).resolves.toBe(false);
      expect(appsV1.patchNamespacedStatefulSet).not.toHaveBeenCalled();
    });

    it('removes the highest-ordinal pod', async () => {
      cluster(4, {});

      await expect(orchestrator.destroyWorker('waha-3')).resolves.toBe(true);
      expect(appsV1.patchNamespacedStatefulSet).toHaveBeenCalledWith(
        'waha',
        'default',
        { spec: { replicas: 3 } },
        undefined, undefined, undefined, undefined, undefined,
        expect.anything(),
      );
    });
  });
});
