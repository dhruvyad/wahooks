import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EventMetricsService } from './event-metrics.service';

/** Event volume counters: written by event ingestion and webhook delivery, read by GET /api/infrastructure/events. */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'webhook-delivery' })],
  providers: [EventMetricsService],
  exports: [EventMetricsService],
})
export class EventMetricsModule {}
