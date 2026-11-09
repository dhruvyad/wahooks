import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WorkersService } from './workers.service';
import { WorkersController } from './workers.controller';
import { GatewayResourcesService } from './gateway-resources.service';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'webhook-delivery' })],
  controllers: [WorkersController],
  providers: [WorkersService, GatewayResourcesService],
  exports: [WorkersService],
})
export class WorkersModule {}
