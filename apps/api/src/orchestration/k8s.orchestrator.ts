import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import {
  ContainerOrchestrator,
  ProvisionResult,
} from './orchestrator.interface';

// Written by the Cluster Autoscaler (its default --status-config-map-name).
const AUTOSCALER_STATUS = { name: 'cluster-autoscaler-status', namespace: 'kube-system' };

@Injectable()
export class K8sOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(K8sOrchestrator.name);
  private readonly appsV1: k8s.AppsV1Api;
  private readonly coreV1: k8s.CoreV1Api;
  private readonly namespace: string;
  private readonly statefulSetName: string;
  private readonly headlessService: string;
  private readonly wahaApiKey: string;
  // A new pod may need a fresh Hetzner node (autoscaler): VM boot + k3s join +
  // image pull commonly takes 2-4 min, so 120s was far too short and left pods
  // orphaned. 5 min covers a cold node add with margin.
  private readonly readyTimeoutMs = 300_000;

  constructor(private readonly configService: ConfigService) {
    const kc = new k8s.KubeConfig();
    // loadFromDefault: tries KUBECONFIG env, in-cluster service account, then ~/.kube/config
    kc.loadFromDefault();

    this.appsV1 = kc.makeApiClient(k8s.AppsV1Api);
    this.coreV1 = kc.makeApiClient(k8s.CoreV1Api);

    this.namespace = configService.get('K8S_NAMESPACE', 'default');
    this.statefulSetName = configService.get('WAHA_STATEFULSET_NAME', 'waha');
    this.headlessService = configService.get('WAHA_HEADLESS_SERVICE', 'waha');
    this.wahaApiKey = configService.getOrThrow<string>('WAHA_API_KEY');
  }

  async provisionWorker(): Promise<ProvisionResult> {
    const { body: sts } = await this.appsV1.readNamespacedStatefulSet(
      this.statefulSetName,
      this.namespace,
    );

    const currentReplicas = sts.spec?.replicas ?? 0;

    // Idempotency: if the highest-ordinal pod isn't Ready yet, a previous
    // provision is still in flight (typically waiting on a new node). Adopt that
    // pod — wait for it and return it — instead of scaling up again, which would
    // orphan pods and over-provision nodes. This is what let a slow node add
    // spiral into waha-1, waha-2, waha-3… each unregistered.
    if (currentReplicas >= 1) {
      const highestPod = this.podName(currentReplicas - 1);
      const status = await this.getWorkerStatus(highestPod);
      if (status !== 'running') {
        this.logger.log(
          `Highest pod ${highestPod} is "${status}" — adopting the in-flight provision instead of scaling up`,
        );
        await this.waitForPodReady(highestPod, this.readyTimeoutMs);
        this.logger.log(`Pod ${highestPod} is Ready`);
        return this.worker(highestPod);
      }
    }

    const newReplicas = currentReplicas + 1;
    const podName = this.podName(currentReplicas); // new pod = waha-{currentReplicas}

    await this.appsV1.patchNamespacedStatefulSet(
      this.statefulSetName,
      this.namespace,
      { spec: { replicas: newReplicas } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );

    this.logger.log(
      `Scaled ${this.statefulSetName} to ${newReplicas} replicas, waiting for ${podName} to be Ready`,
    );

    await this.waitForPodReady(podName, this.readyTimeoutMs);

    this.logger.log(`Pod ${podName} is Ready`);

    return this.worker(podName);
  }

  async listReadyWorkers(): Promise<ProvisionResult[]> {
    const { body: sts } = await this.appsV1.readNamespacedStatefulSet(
      this.statefulSetName,
      this.namespace,
    );
    const pods = Array.from({ length: sts.spec?.replicas ?? 0 }, (_, i) =>
      this.podName(i),
    );
    const statuses = await Promise.all(pods.map((p) => this.getWorkerStatus(p)));
    return pods
      .filter((_, i) => statuses[i] === 'running')
      .map((p) => this.worker(p));
  }

  async destroyWorker(podName: string): Promise<boolean> {
    const { body: sts } = await this.appsV1.readNamespacedStatefulSet(
      this.statefulSetName,
      this.namespace,
    );

    const currentReplicas = sts.spec?.replicas ?? 0;

    if (currentReplicas <= 1) {
      this.logger.warn(
        `Cannot scale ${this.statefulSetName} below 1 replica — skipping destroy of ${podName}`,
      );
      return false;
    }

    // k8s StatefulSets always remove the highest-ordinal pod on scale-down.
    // Validate that podName is that pod to avoid removing the wrong one.
    const ordinalMatch = podName.match(/-(\d+)$/);
    const ordinal = ordinalMatch ? parseInt(ordinalMatch[1], 10) : -1;
    const expectedHighest = currentReplicas - 1;

    if (ordinal !== expectedHighest) {
      this.logger.warn(
        `Pod ${podName} (ordinal ${ordinal}) is not the current highest-ordinal pod ` +
          `(${this.statefulSetName}-${expectedHighest}). Skipping scale-down to avoid ` +
          `removing a pod with active sessions. Will retry when it becomes highest-ordinal.`,
      );
      return false;
    }

    await this.appsV1.patchNamespacedStatefulSet(
      this.statefulSetName,
      this.namespace,
      { spec: { replicas: expectedHighest } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );

    this.logger.log(
      `Scaled ${this.statefulSetName} down to ${expectedHighest} replicas (removed ${podName})`,
    );
    return true;
  }

  async getWorkerStatus(
    podName: string,
  ): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const { body: pod } = await this.coreV1.readNamespacedPod(
        podName,
        this.namespace,
      );

      const phase = pod.status?.phase;
      const ready =
        pod.status?.conditions?.find(
          (c: k8s.V1NodeCondition) => c.type === 'Ready',
        )?.status === 'True';

      if (phase === 'Running' && ready) return 'running';
      if (phase === 'Succeeded' || phase === 'Failed') return 'stopped';

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private podName(ordinal: number): string {
    return `${this.statefulSetName}-${ordinal}`;
  }

  private worker(podName: string): ProvisionResult {
    return {
      podName,
      internalIp: `${podName}.${this.headlessService}.${this.namespace}.svc.cluster.local`,
      apiKey: this.wahaApiKey,
    };
  }

  private async waitForPodReady(
    podName: string,
    timeoutMs = 120_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 3_000;
    let autoscalerReadable = true;

    while (Date.now() < deadline) {
      const status = await this.getWorkerStatus(podName);
      if (status === 'running') return;

      // A pod that can't be scheduled waits on the autoscaler for a node; once
      // the autoscaler has backed off a failed scale-up, waiting is pointless.
      const unschedulable = await this.unschedulableReason(podName);
      if (unschedulable && autoscalerReadable) {
        let backoff: string | null = null;
        try {
          backoff = await this.autoscalerBackoff();
        } catch (error) {
          autoscalerReadable = false;
          this.logger.warn(
            `Can't read the cluster autoscaler's status (${error instanceof Error ? error.message : String(error)}) — waiting out the timeout for ${podName}`,
          );
        }
        if (backoff) {
          throw new Error(
            `Pod ${podName} can't be scheduled (${unschedulable}) and the cluster autoscaler can't add a node: ${backoff}`,
          );
        }
      }

      this.logger.debug(
        `Waiting for pod ${podName} to be Ready (status: ${status})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const unschedulable = await this.unschedulableReason(podName);
    throw new Error(
      `Pod ${podName} did not become Ready within ${timeoutMs / 1000}s` +
        (unschedulable ? ` (unschedulable: ${unschedulable})` : ''),
    );
  }

  /** The scheduler's message when the pod has no node to run on, else null. */
  private async unschedulableReason(podName: string): Promise<string | null> {
    try {
      const { body: pod } = await this.coreV1.readNamespacedPod(
        podName,
        this.namespace,
      );
      const scheduled = pod.status?.conditions?.find(
        (c) => c.type === 'PodScheduled',
      );
      return scheduled?.status === 'False' && scheduled.reason === 'Unschedulable'
        ? (scheduled.message ?? 'Unschedulable')
        : null;
    } catch {
      return null;
    }
  }

  /** Why the autoscaler stopped adding nodes, when any node group is in scale-up backoff. */
  private async autoscalerBackoff(): Promise<string | null> {
    const { body: cm } = await this.coreV1.readNamespacedConfigMap(
      AUTOSCALER_STATUS.name,
      AUTOSCALER_STATUS.namespace,
    );
    const status = k8s.loadYaml<any>(cm.data?.status ?? '');
    const blocked = (status?.nodeGroups ?? [])
      .filter((g: any) => g?.scaleUp?.status === 'Backoff')
      .map(
        (g: any) =>
          `${g.name}: ${g.scaleUp.backoffInfo?.errorMessage ?? g.scaleUp.backoffInfo?.errorCode ?? 'scale-up backoff'}`,
      );
    return blocked.length > 0 ? blocked.join('; ') : null;
  }
}
