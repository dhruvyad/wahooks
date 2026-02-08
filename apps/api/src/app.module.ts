import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { AppController } from "./app.controller";
import { DatabaseModule } from "./database/database.module";
import { OrchestrationModule } from "./orchestration/orchestration.module";
import { WahaModule } from "./waha/waha.module";
import { WorkersModule } from "./workers/workers.module";
import { ConnectionsModule } from "./connections/connections.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    OrchestrationModule,
    WahaModule,
    WorkersModule,
    ConnectionsModule,
    HealthModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
