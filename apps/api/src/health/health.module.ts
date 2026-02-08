import { Module } from '@nestjs/common';
import { HealthService } from './health.service';

@Module({
  providers: [HealthService],
})
export class HealthModule {}
