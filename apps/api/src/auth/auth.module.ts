import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { TokensController } from './tokens.controller';

@Module({
  controllers: [TokensController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
