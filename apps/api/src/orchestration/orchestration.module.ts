import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ORCHESTRATOR_TOKEN } from './orchestrator.interface';
import { HetznerOrchestrator } from './hetzner.orchestrator';
import { K8sOrchestrator } from './k8s.orchestrator';
import { MockOrchestrator } from './mock.orchestrator';

@Global()
@Module({
  providers: [
    {
      provide: ORCHESTRATOR_TOKEN,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
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
      },
    },
  ],
  exports: [ORCHESTRATOR_TOKEN],
})
export class OrchestrationModule {}
