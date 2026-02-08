import {
  Controller,
  Get,
  Post,
  Inject,
  UseGuards,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { users } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';
import { UsageService } from './usage.service';

@Controller('billing')
@UseGuards(AuthGuard)
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly stripeService: StripeService,
    private readonly usageService: UsageService,
    private readonly configService: ConfigService,
  ) {}

  @Get('status')
  async getStatus(@CurrentUser() user: { sub: string }) {
    const stripeCustomerId = await this.ensureStripeCustomer(user.sub);

    const subscriptions =
      await this.stripeService.getCustomerSubscriptions(stripeCustomerId);

    const activeSubscription = subscriptions.find(
      (sub) =>
        sub.status === 'active' ||
        sub.status === 'trialing' ||
        sub.status === 'past_due',
    );

    const usage = await this.usageService.getUserUsageSummary(user.sub);

    return {
      hasPaymentMethod: !!activeSubscription,
      subscriptionStatus: activeSubscription?.status ?? null,
      usage,
    };
  }

  @Post('checkout')
  async createCheckout(@CurrentUser() user: { sub: string }) {
    const stripeCustomerId = await this.ensureStripeCustomer(user.sub);

    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const successUrl = `${frontendUrl}/billing?success=true`;
    const cancelUrl = `${frontendUrl}/billing?canceled=true`;

    const url = await this.stripeService.createCheckoutSession(
      stripeCustomerId,
      successUrl,
      cancelUrl,
    );

    return { url };
  }

  @Post('portal')
  async createPortal(@CurrentUser() user: { sub: string }) {
    const stripeCustomerId = await this.ensureStripeCustomer(user.sub);

    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const returnUrl = `${frontendUrl}/billing`;

    const url = await this.stripeService.createPortalSession(
      stripeCustomerId,
      returnUrl,
    );

    return { url };
  }

  @Get('usage')
  async getUsage(@CurrentUser() user: { sub: string }) {
    return this.usageService.getUserUsageSummary(user.sub);
  }

  private async ensureStripeCustomer(userId: string): Promise<string> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customerId = await this.stripeService.createCustomer(
      user.email,
      userId,
    );

    await this.db
      .update(users)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(users.id, userId));

    this.logger.log(
      `Created Stripe customer ${customerId} for user ${userId}`,
    );

    return customerId;
  }
}
