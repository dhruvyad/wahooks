import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import {
  ContainerOrchestrator,
  ProvisionResult,
} from './orchestrator.interface';

@Injectable()
export class K8sOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(K8sOrchestrator.name);
  private readonly appsV1: k8s.AppsV1Api;
  private readonly coreV1: k8s.CoreV1Api;
  private readonly namespace: string;
  private readonly statefulSetName: string;
  private readonly headlessService: string;
  private readonly wahaApiKey: string;

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
    const newReplicas = currentReplicas + 1;
    const podOrdinal = currentReplicas; // new pod will be waha-{currentReplicas}
    const podName = `${this.statefulSetName}-${podOrdinal}`;

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

    await this.waitForPodReady(podName);

    const internalIp = `${podName}.${this.headlessService}.${this.namespace}.svc.cluster.local`;

    this.logger.log(`Pod ${podName} is Ready at ${internalIp}`);

    return { podName, internalIp, apiKey: this.wahaApiKey };
  }

  async destroyWorker(podName: string): Promise<void> {
    const { body: sts } = await this.appsV1.readNamespacedStatefulSet(
      this.statefulSetName,
      this.namespace,
    );

    const currentReplicas = sts.spec?.replicas ?? 0;

    if (currentReplicas <= 1) {
      this.logger.warn(
        `Cannot scale ${this.statefulSetName} below 1 replica — skipping destroy of ${podName}`,
      );
      return;
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
      return;
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

  private async waitForPodReady(
    podName: string,
    timeoutMs = 120_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 3_000;

    while (Date.now() < deadline) {
      const status = await this.getWorkerStatus(podName);
      if (status === 'running') return;

      this.logger.debug(
        `Waiting for pod ${podName} to be Ready (status: ${status})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Pod ${podName} did not become Ready within ${timeoutMs / 1000}s`,
    );
  }
}
