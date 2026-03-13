import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('STRIPE_SECRET_KEY', '');
    this.stripe = new Stripe(
      key || 'sk_not_configured',
      { apiVersion: '2025-04-30.basil' as any },
    );
    if (!key) {
      this.logger.warn('STRIPE_SECRET_KEY not set — billing calls will fail');
    }
  }

  // Create a Stripe customer for a new user
  async createCustomer(email: string, userId: string): Promise<string> {
    const customer = await this.stripe.customers.create({
      email,
      metadata: { wahooks_user_id: userId },
    });
    this.logger.log(`Created Stripe customer ${customer.id} for user ${userId}`);
    return customer.id;
  }

  // Create a metered subscription for the user
  // Uses a single metered price for connection-hours
  async createSubscription(customerId: string): Promise<{ subscriptionId: string; subscriptionItemId: string }> {
    const priceId = this.configService.get<string>('STRIPE_PRICE_ID', '');
    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
    return {
      subscriptionId: subscription.id,
      subscriptionItemId: subscription.items.data[0].id,
    };
  }

  // Report usage to Stripe (connection-hours)
  async reportUsage(subscriptionItemId: string, quantity: number, timestamp: number): Promise<void> {
    await (this.stripe.subscriptionItems as any).createUsageRecord(subscriptionItemId, {
      quantity: Math.ceil(quantity), // Stripe uses integers
      timestamp,
      action: 'increment',
    });
    this.logger.log(`Reported ${quantity} connection-hours to Stripe item ${subscriptionItemId}`);
  }

  // Create a Stripe Checkout Session for the user to set up payment
  async createCheckoutSession(customerId: string, successUrl: string, cancelUrl: string): Promise<string> {
    const priceId = this.configService.get<string>('STRIPE_PRICE_ID', '');
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return session.url!;
  }

  // Create a Stripe Customer Portal session
  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  // Construct a webhook event from the raw body and signature
  constructWebhookEvent(body: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET', '');
    return this.stripe.webhooks.constructEvent(body, signature, webhookSecret);
  }

  // Get subscription details
  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId);
  }

  // Get customer's subscriptions
  async getCustomerSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
    const subs = await this.stripe.subscriptions.list({ customer: customerId });
    return subs.data;
  }
}
