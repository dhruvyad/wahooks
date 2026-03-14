import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [ConnectionsController],
})
export class ConnectionsModule {}
