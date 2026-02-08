import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ConnectionsController],
})
export class ConnectionsModule {}
