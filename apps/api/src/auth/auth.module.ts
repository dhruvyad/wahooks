import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { TokensController } from './tokens.controller';
import { MeController } from './me.controller';

@Module({
  controllers: [TokensController, MeController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
