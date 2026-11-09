import type { WorkerKind } from '@wahooks/db';

export type { WorkerKind };

export interface ProvisionResult {
  podName: string; // k8s: "waha-0"; gateway: the Hetzner server name; hetzner (legacy): server ID string
  internalIp: string;
  // The key the API sends as X-Api-Key. '' from listReadyWorkers when the
  // orchestrator doesn't know it (a gateway box's key lives in its worker row).
  apiKey: string;
}

export interface ProvisionHooks {
  /**
   * Called once the worker exists but before it is ready, so its key can be
   * persisted before a long wait. A throw aborts the provision and removes the
   * worker. Orchestrators whose workers share a known key may skip it.
   */
  onCreated?(result: ProvisionResult): Promise<void>;
}

export interface ContainerOrchestrator {
  provisionWorker(hooks?: ProvisionHooks): Promise<ProvisionResult>;
  /**
   * Returns false when the orchestrator kept the worker (e.g. it can't remove
   * that pod yet). `allowLast` lets a StatefulSet go to zero replicas.
   */
  destroyWorker(podName: string, opts?: { allowLast?: boolean }): Promise<boolean>;
  getWorkerStatus(
    podName: string,
  ): Promise<'running' | 'stopped' | 'unknown'>;
  /** Every worker that is up and ready to take sessions, registered or not. */
  listReadyWorkers(): Promise<ProvisionResult[]>;
}

/** One orchestrator per worker kind; null when that kind can't be provisioned. */
export type WorkerOrchestrators = Record<WorkerKind, ContainerOrchestrator | null>;

export const WORKER_ORCHESTRATORS_TOKEN = 'WORKER_ORCHESTRATORS';
