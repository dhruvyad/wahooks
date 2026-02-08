export interface ProvisionResult {
  hetznerServerId: string;
  internalIp: string;
  apiKey: string; // generated WAHA API key
}

export interface ContainerOrchestrator {
  provisionWorker(): Promise<ProvisionResult>;
  destroyWorker(hetznerServerId: string): Promise<void>;
  getWorkerStatus(
    hetznerServerId: string,
  ): Promise<'running' | 'stopped' | 'unknown'>;
}

export const ORCHESTRATOR_TOKEN = 'CONTAINER_ORCHESTRATOR';
