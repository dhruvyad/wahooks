export interface ProvisionResult {
  podName: string; // k8s: "waha-0"; hetzner (legacy): server ID string
  internalIp: string;
  apiKey: string; // generated WAHA API key
}

export interface ContainerOrchestrator {
  provisionWorker(): Promise<ProvisionResult>;
  destroyWorker(podName: string): Promise<void>;
  getWorkerStatus(
    podName: string,
  ): Promise<'running' | 'stopped' | 'unknown'>;
}

export const ORCHESTRATOR_TOKEN = 'CONTAINER_ORCHESTRATOR';
