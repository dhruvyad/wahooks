import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EventsController } from './events.controller';
import { EventsGateway } from './events.gateway';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhookLogRetentionService } from './webhook-log-retention.service';

/**
 * BullMQ keeps only this many failed delivery jobs (removeOnFail), so the
 * queue's failed count stops here: a retention window, not a backlog.
 */
export const FAILED_JOBS_KEPT = 1000;

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>(
          'REDIS_URL',
          'redis://localhost:6379',
        );
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            password: url.password || undefined,
            tls: url.protocol === 'rediss:' ? {} : undefined,
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: 'webhook-delivery',
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s, 40s, 80s
        },
        removeOnComplete: 100, // keep last 100 completed
        removeOnFail: FAILED_JOBS_KEPT, // keep the newest 1000 failed jobs for inspection
      },
    }),
  ],
  controllers: [EventsController],
  providers: [WebhookDeliveryProcessor, EventsGateway, WebhookLogRetentionService],
  exports: [EventsGateway, WebhookLogRetentionService],
})
export class EventsModule {}
