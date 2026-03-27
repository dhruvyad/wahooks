import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);
  private readonly usdPriceId: string;
  private readonly inrPriceId: string;

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('STRIPE_SECRET_KEY', '');
    this.stripe = new Stripe(
      key || 'sk_not_configured',
      { apiVersion: '2025-04-30.basil' as any },
    );
    this.usdPriceId = this.configService.get<string>(
      'STRIPE_USD_PRICE_ID', '',
    ) || 'price_1TAtV21NPzR4qyVq9NP7qO5O';
    this.inrPriceId = this.configService.get<string>(
      'STRIPE_INR_PRICE_ID', '',
    ) || 'price_1TAtV31NPzR4qyVqSDNOfSNx';
    if (!key) {
      this.logger.warn('STRIPE_SECRET_KEY not set — billing calls will fail');
    }
  }

  async createCustomer(email: string, userId: string): Promise<string> {
    const customer = await this.stripe.customers.create({
      email,
      metadata: { wahooks_user_id: userId },
    });
    this.logger.log(`Created Stripe customer ${customer.id} for user ${userId}`);
    return customer.id;
  }

  /**
   * Create a Checkout Session for buying connection slots.
   * Quantity = number of slots to purchase.
   */
  async createCheckoutSession(
    customerId: string,
    quantity: number,
    currency: 'usd' | 'inr',
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const priceId = currency === 'inr' ? this.inrPriceId : this.usdPriceId;

    // Check if customer already has an active subscription
    const subs = await this.stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    if (subs.data.length > 0) {
      // Existing subscriber — redirect to Stripe Customer Portal for upgrades.
      // The portal lets users change quantity with payment confirmation,
      // preventing slots from being granted without explicit approval.
      const portalSession = await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: successUrl,
        flow_data: {
          type: 'subscription_update',
          subscription_update: {
            subscription: subs.data[0].id,
          },
        },
      });

      this.logger.log(
        `Redirecting existing subscriber to portal for upgrade (sub: ${subs.data[0].id})`,
      );

      return portalSession.url;
    }

    // New subscription via Checkout
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return session.url!;
  }

  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  /**
   * Get the number of paid connection slots for a customer.
   */
  async getPaidSlots(customerId: string): Promise<number> {
    const subs = await this.stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    if (subs.data.length === 0) return 0;

    const sub = subs.data[0];
    return sub.items.data[0]?.quantity ?? 0;
  }

  /**
   * Get subscription status for a customer.
   */
  async getSubscriptionStatus(customerId: string): Promise<{
    active: boolean;
    slots: number;
    status: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    monthlyAmount: number;
    currency: string;
  }> {
    const subs = await this.stripe.subscriptions.list({
      customer: customerId,
      limit: 1,
    });

    if (subs.data.length === 0) {
      return {
        active: false,
        slots: 0,
        status: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        monthlyAmount: 0,
        currency: 'usd',
      };
    }

    const sub = subs.data[0];
    const item = sub.items.data[0];
    const qty = item?.quantity ?? 0;
    const unitAmount = item?.price?.unit_amount ?? 0;

    // In basil API, current_period_end moved from Subscription to SubscriptionItem
    const periodEnd = (item as any)?.current_period_end ?? 0;

    return {
      active: sub.status === 'active',
      slots: qty,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      monthlyAmount: (unitAmount * qty) / 100,
      currency: item?.price?.currency ?? 'usd',
    };
  }

  constructWebhookEvent(body: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');
    return this.stripe.webhooks.constructEvent(body, signature, webhookSecret);
  }
}
