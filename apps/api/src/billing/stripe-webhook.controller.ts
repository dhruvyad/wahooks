import { Controller, Post, Req, Res, Logger, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { eq, ne, and, desc } from 'drizzle-orm';
import { users, wahaSessions } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';

interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  send(body: string): ExpressResponse;
  json(body: unknown): ExpressResponse;
}

@SkipThrottle()
@Controller('stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  // Track processed event IDs to prevent double-processing on retries
  private readonly processedEvents = new Set<string>();
  private readonly MAX_PROCESSED_EVENTS = 1000;

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly stripeService: StripeService,
  ) {}

  @Post('webhook')
  async handleWebhook(@Req() req: RawRequest, @Res() res: ExpressResponse) {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      this.logger.error('Missing stripe-signature header');
      return res.status(400).send('Missing stripe-signature header');
    }

    let event;
    try {
      event = this.stripeService.constructWebhookEvent(
        req.rawBody!,
        signature,
      );
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err}`);
      return res.status(400).send(`Webhook Error: ${err}`);
    }

    // Idempotency: skip if we've already processed this event
    if (this.processedEvents.has(event.id)) {
      this.logger.log(`Stripe webhook: ${event.type} (event ${event.id} already processed, skipping)`);
      return res.json({ received: true });
    }
    this.processedEvents.add(event.id);
    // Prevent unbounded memory growth
    if (this.processedEvents.size > this.MAX_PROCESSED_EVENTS) {
      const oldest = this.processedEvents.values().next().value;
      if (oldest) this.processedEvents.delete(oldest);
    }

    this.logger.log(`Stripe webhook: ${event.type} (event ${event.id})`);

    switch (event.type) {
      case 'customer.subscription.updated': {
        const subscription = event.data.object as any;
        const customerId = subscription.customer as string;
        const newQuantity = subscription.items?.data?.[0]?.quantity ?? 0;
        const status = subscription.status;
        const cancelAtPeriodEnd = subscription.cancel_at_period_end ?? false;

        this.logger.log(
          `Subscription updated: customer=${customerId} status=${status} quantity=${newQuantity} cancelAtPeriodEnd=${cancelAtPeriodEnd}`,
        );

        if (status === 'canceled' || status === 'unpaid') {
          // Subscription actually expired or payment failed permanently
          await this.enforceSlotLimit(customerId, 0);
        } else if (status === 'active' || status === 'past_due') {
          // Always enforce the current quantity limit.
          // If cancelAtPeriodEnd=true, the user still has access to their
          // paid slots — they just won't renew. But if they downgraded
          // the quantity, we enforce the new limit immediately.
          await this.enforceSlotLimit(customerId, newQuantity);

          if (cancelAtPeriodEnd) {
            this.logger.log(
              `Subscription will cancel at period end — connections kept within ${newQuantity} slot limit`,
            );
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Fires when the subscription period actually ends after cancellation
        const subscription = event.data.object as any;
        const customerId = subscription.customer as string;

        this.logger.log(
          `Subscription expired: customer=${customerId} — stopping all connections`,
        );

        await this.enforceSlotLimit(customerId, 0);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        this.logger.warn(
          `Payment failed: invoice=${invoice.id} customer=${invoice.customer}`,
        );
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as any;
        this.logger.log(
          `Invoice paid: invoice=${invoice.id} customer=${invoice.customer}`,
        );
        break;
      }

      default:
        this.logger.log(`Unhandled event: ${event.type}`);
    }

    return res.json({ received: true });
  }

  /**
   * Enforce slot limit: if a user has more active connections than allowed,
   * stop the excess (newest first).
   */
  private async enforceSlotLimit(
    stripeCustomerId: string,
    allowedSlots: number,
  ): Promise<void> {
    // Find user by Stripe customer ID
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.stripeCustomerId, stripeCustomerId));

    if (!user) {
      this.logger.warn(`No user found for Stripe customer ${stripeCustomerId}`);
      return;
    }

    // Get active connections ordered by creation (newest first)
    const activeConnections = await this.db
      .select()
      .from(wahaSessions)
      .where(
        and(
          eq(wahaSessions.userId, user.id),
          ne(wahaSessions.status, 'stopped'),
        ),
      )
      .orderBy(desc(wahaSessions.createdAt));

    const excess = activeConnections.length - allowedSlots;

    if (excess <= 0) {
      this.logger.log(
        `User ${user.email}: ${activeConnections.length} connections within ${allowedSlots} slot limit`,
      );
      return;
    }

    // Stop the newest connections first (preserve older ones)
    const toStop = activeConnections.slice(0, excess);
    this.logger.warn(
      `User ${user.email}: stopping ${excess} connections (${activeConnections.length} active, ${allowedSlots} allowed)`,
    );

    for (const conn of toStop) {
      await this.db
        .update(wahaSessions)
        .set({ status: 'stopped', workerId: null, updatedAt: new Date() })
        .where(eq(wahaSessions.id, conn.id));

      this.logger.log(`Stopped connection ${conn.id} (${conn.sessionName})`);
    }
  }
}
