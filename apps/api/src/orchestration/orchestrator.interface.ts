export interface ProvisionResult {
  podName: string; // k8s: "waha-0"; hetzner (legacy): server ID string
  internalIp: string;
  apiKey: string; // generated WAHA API key
}

export interface ContainerOrchestrator {
  provisionWorker(): Promise<ProvisionResult>;
  /** Returns false when the orchestrator kept the worker (e.g. it can't remove that pod yet). */
  destroyWorker(podName: string): Promise<boolean>;
  getWorkerStatus(
    podName: string,
  ): Promise<'running' | 'stopped' | 'unknown'>;
  /** Every worker that is up and ready to take sessions, registered or not. */
  listReadyWorkers(): Promise<ProvisionResult[]>;
}

export const ORCHESTRATOR_TOKEN = 'CONTAINER_ORCHESTRATOR';
