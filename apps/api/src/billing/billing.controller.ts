import {
  Controller,
  Get,
  Post,
  Body,
  Inject,
  UseGuards,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, ne, and } from 'drizzle-orm';
import { users, wahaSessions } from '@wahooks/db';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';

@Controller('billing')
@UseGuards(AuthGuard)
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Get billing status: paid slots, active connections, subscription details.
   */
  @Get('status')
  async getStatus(@CurrentUser() user: { sub: string }) {
    const stripeCustomerId = await this.ensureStripeCustomer(user.sub);

    const subscription =
      await this.stripeService.getSubscriptionStatus(stripeCustomerId);

    // Count active (non-stopped) connections for this user
    const activeConnections = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          ne(wahaSessions.status, 'stopped'),
        ),
      );

    const usedSlots = activeConnections.length;
    const availableSlots = Math.max(0, subscription.slots - usedSlots);

    return {
      subscription: {
        active: subscription.active,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
        monthlyAmount: subscription.monthlyAmount,
        currency: subscription.currency,
      },
      slots: {
        paid: subscription.slots,
        used: usedSlots,
        available: availableSlots,
      },
    };
  }

  /**
   * Buy connection slots. Creates or updates a Stripe subscription.
   */
  @Post('checkout')
  async createCheckout(
    @CurrentUser() user: { sub: string },
    @Body() body: { quantity?: number; currency?: 'usd' | 'inr' },
  ) {
    const stripeCustomerId = await this.ensureStripeCustomer(user.sub);
    const quantity = body.quantity ?? 1;
    const currency = body.currency ?? 'usd';

    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://wahooks.com',
    );
    const successUrl = `${frontendUrl}/billing?success=true`;
    const cancelUrl = `${frontendUrl}/billing?canceled=true`;

    const url = await this.stripeService.createCheckoutSession(
      stripeCustomerId,
      quantity,
      currency,
      successUrl,
      cancelUrl,
    );

    return { url };
  }

  /**
   * Open Stripe Customer Portal to manage subscription.
   */
  @Post('portal')
  async createPortal(@CurrentUser() user: { sub: string }) {
    const stripeCustomerId = await this.ensureStripeCustomer(user.sub);

    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://wahooks.com',
    );

    const url = await this.stripeService.createPortalSession(
      stripeCustomerId,
      `${frontendUrl}/billing`,
    );

    return { url };
  }

  /**
   * Check if user has available connection slots.
   * Used by createConnection to enforce billing.
   */
  @Get('can-create')
  async canCreateConnection(@CurrentUser() user: { sub: string }) {
    const stripeCustomerId = await this.getStripeCustomerId(user.sub);
    if (!stripeCustomerId) {
      return { allowed: false, reason: 'No billing set up' };
    }

    const paidSlots = await this.stripeService.getPaidSlots(stripeCustomerId);
    const activeConnections = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.sub),
          ne(wahaSessions.status, 'stopped'),
        ),
      );

    const available = paidSlots - activeConnections.length;

    if (available <= 0) {
      return {
        allowed: false,
        reason: `All ${paidSlots} slots in use`,
        paidSlots,
        usedSlots: activeConnections.length,
      };
    }

    return {
      allowed: true,
      paidSlots,
      usedSlots: activeConnections.length,
      availableSlots: available,
    };
  }

  private async ensureStripeCustomer(userId: string): Promise<string> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));

    if (!user) throw new NotFoundException('User not found');

    if (user.stripeCustomerId) return user.stripeCustomerId;

    const customerId = await this.stripeService.createCustomer(
      user.email,
      userId,
    );

    await this.db
      .update(users)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(users.id, userId));

    return customerId;
  }

  private async getStripeCustomerId(userId: string): Promise<string | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));

    return user?.stripeCustomerId ?? null;
  }
}
