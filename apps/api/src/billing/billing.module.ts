import { Module } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { UsageService } from './usage.service';
import { BillingController } from './billing.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [StripeService, UsageService],
  controllers: [BillingController, StripeWebhookController],
  exports: [StripeService, UsageService],
})
export class BillingModule {}
