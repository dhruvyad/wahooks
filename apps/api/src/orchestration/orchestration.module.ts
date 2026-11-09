import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ContainerOrchestrator,
  WORKER_ORCHESTRATORS_TOKEN,
  WorkerOrchestrators,
} from './orchestrator.interface';
import { HetznerOrchestrator } from './hetzner.orchestrator';
import { K8sOrchestrator } from './k8s.orchestrator';
import { MockOrchestrator } from './mock.orchestrator';
import { GatewayOrchestrator } from './gateway.orchestrator';

/** WAHA workers: chosen by ORCHESTRATOR (k8s in production, mock in dev). */
export function selectWahaOrchestrator(configService: ConfigService): ContainerOrchestrator {
  const orchestrator = configService.get<string>('ORCHESTRATOR');
  const nodeEnv = configService.get<string>('NODE_ENV');
  const choice =
    orchestrator === 'k8s'
      ? 'k8s'
      : orchestrator === 'hetzner'
        ? 'hetzner'
        : nodeEnv === 'production'
          ? 'k8s'
          : 'mock';

  switch (choice) {
    case 'k8s':
      return new K8sOrchestrator(configService);
    case 'hetzner':
      return new HetznerOrchestrator(configService);
    default:
      return new MockOrchestrator();
  }
}

@Global()
@Module({
  providers: [
    {
      // Lazy: only the selected WAHA orchestrator is built, and the gateway one
      // only when its env is set (otherwise gateway boxes can't be provisioned).
      provide: WORKER_ORCHESTRATORS_TOKEN,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): WorkerOrchestrators => ({
        waha: selectWahaOrchestrator(configService),
        gateway: GatewayOrchestrator.fromConfig(configService),
      }),
    },
  ],
  exports: [WORKER_ORCHESTRATORS_TOKEN],
})
export class OrchestrationModule {}
