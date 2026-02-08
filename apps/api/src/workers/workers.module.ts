import { Global, Module } from '@nestjs/common';
import { WorkersService } from './workers.service';

@Global()
@Module({
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
