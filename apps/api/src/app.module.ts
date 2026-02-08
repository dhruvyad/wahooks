import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { AppController } from "./app.controller";
import { DatabaseModule } from "./database/database.module";
import { OrchestrationModule } from "./orchestration/orchestration.module";
import { WahaModule } from "./waha/waha.module";
import { WorkersModule } from "./workers/workers.module";
import { ConnectionsModule } from "./connections/connections.module";
import { HealthModule } from "./health/health.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { EventsModule } from "./events/events.module";
import { BillingModule } from "./billing/billing.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 60,
        },
      ],
    }),
    DatabaseModule,
    OrchestrationModule,
    WahaModule,
    WorkersModule,
    ConnectionsModule,
    HealthModule,
    WebhooksModule,
    EventsModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
