import { Module } from "@nestjs/common";
import { APP_GUARD, APP_PIPE } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { CallerThrottlerGuard, RATE_LIMITS } from "./auth/caller-throttler.guard";
import { AppController } from "./app.controller";
import { UuidParamPipe } from "./common/uuid-param.pipe";
import { DatabaseModule } from "./database/database.module";
import { OrchestrationModule } from "./orchestration/orchestration.module";
import { WahaModule } from "./waha/waha.module";
import { WorkersModule } from "./workers/workers.module";
import { ConnectionsModule } from "./connections/connections.module";
import { HealthModule } from "./health/health.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { EventsModule } from "./events/events.module";
import { EventMetricsModule } from "./events/event-metrics.module";
import { BillingModule } from "./billing/billing.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({ throttlers: RATE_LIMITS }),
    DatabaseModule,
    OrchestrationModule,
    WahaModule,
    WorkersModule,
    ConnectionsModule,
    HealthModule,
    WebhooksModule,
    EventsModule,
    EventMetricsModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CallerThrottlerGuard,
    },
    { provide: APP_PIPE, useClass: UuidParamPipe },
  ],
})
export class AppModule {}
