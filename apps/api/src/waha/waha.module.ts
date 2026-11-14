import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WahaService } from './waha.service';
import { TypingStateService } from './typing-state.service';

@Global()
@Module({
  // The webhook queue's Redis connection holds the typing state (TypingStateService).
  imports: [BullModule.registerQueue({ name: 'webhook-delivery' })],
  providers: [WahaService, TypingStateService],
  exports: [WahaService],
})
export class WahaModule {}
