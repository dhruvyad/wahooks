import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ORCHESTRATOR_TOKEN } from './orchestrator.interface';
import { HetznerOrchestrator } from './hetzner.orchestrator';
import { MockOrchestrator } from './mock.orchestrator';

@Global()
@Module({
  providers: [
    HetznerOrchestrator,
    MockOrchestrator,
    {
      provide: ORCHESTRATOR_TOKEN,
      inject: [ConfigService, HetznerOrchestrator, MockOrchestrator],
      useFactory: (
        configService: ConfigService,
        hetzner: HetznerOrchestrator,
        mock: MockOrchestrator,
      ) => {
        const nodeEnv = configService.get<string>('NODE_ENV');
        return nodeEnv === 'production' ? hetzner : mock;
      },
    },
  ],
  exports: [ORCHESTRATOR_TOKEN],
})
export class OrchestrationModule {}
