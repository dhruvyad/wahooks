import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
