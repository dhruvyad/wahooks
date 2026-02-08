import { Global, Module } from '@nestjs/common';
import { WahaService } from './waha.service';

@Global()
@Module({
  providers: [WahaService],
  exports: [WahaService],
})
export class WahaModule {}
