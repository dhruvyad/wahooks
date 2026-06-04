import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WorkersService } from './workers.service';
import { WorkersController } from './workers.controller';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'webhook-delivery' })],
  controllers: [WorkersController],
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
