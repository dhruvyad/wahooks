import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ORCHESTRATOR_TOKEN } from './orchestrator.interface';
import { HetznerOrchestrator } from './hetzner.orchestrator';
import { K8sOrchestrator } from './k8s.orchestrator';
import { MockOrchestrator } from './mock.orchestrator';

@Global()
@Module({
  providers: [
    HetznerOrchestrator,
    K8sOrchestrator,
    MockOrchestrator,
    {
      provide: ORCHESTRATOR_TOKEN,
      inject: [ConfigService, HetznerOrchestrator, K8sOrchestrator, MockOrchestrator],
      useFactory: (
        configService: ConfigService,
        hetzner: HetznerOrchestrator,
        k8s: K8sOrchestrator,
        mock: MockOrchestrator,
      ) => {
        const orchestrator = configService.get<string>('ORCHESTRATOR');
        if (orchestrator === 'k8s') return k8s;
        if (orchestrator === 'hetzner') return hetzner;
        // Default: k8s in production, mock in dev
        const nodeEnv = configService.get<string>('NODE_ENV');
        return nodeEnv === 'production' ? k8s : mock;
      },
    },
  ],
  exports: [ORCHESTRATOR_TOKEN],
})
export class OrchestrationModule {}
