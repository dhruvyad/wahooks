import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { DatabaseModule } from "./database/database.module";
import { ConnectionsModule } from "./connections/connections.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    ConnectionsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
