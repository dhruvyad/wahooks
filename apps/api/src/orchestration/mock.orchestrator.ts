import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  ContainerOrchestrator,
  ProvisionResult,
} from './orchestrator.interface';

@Injectable()
export class MockOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(MockOrchestrator.name);

  async provisionWorker(): Promise<ProvisionResult> {
    const podName = `mock-${Date.now()}`;
    const octet = Math.floor(Math.random() * 255) + 1;
    const internalIp = `10.0.0.${octet}`;
    const apiKey = crypto.randomBytes(32).toString('hex');

    this.logger.log(`[Mock] Provisioned worker ${podName} at ${internalIp}`);

    return { podName, internalIp, apiKey };
  }

  async destroyWorker(podName: string): Promise<void> {
    this.logger.log(`[Mock] Destroyed worker ${podName}`);
  }

  async getWorkerStatus(
    _podName: string,
  ): Promise<'running' | 'stopped' | 'unknown'> {
    return 'running';
  }
}
