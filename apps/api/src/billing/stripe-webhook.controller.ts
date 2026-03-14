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

    this.logger.log(`Stripe webhook: ${event.type}`);

    switch (event.type) {
      case 'customer.subscription.updated': {
        const subscription = event.data.object as any;
        const customerId = subscription.customer as string;
        const newQuantity = subscription.items?.data?.[0]?.quantity ?? 0;
        const status = subscription.status;

        this.logger.log(
          `Subscription updated: customer=${customerId} status=${status} quantity=${newQuantity}`,
        );

        // If subscription is canceled or unpaid, stop excess connections
        if (status === 'canceled' || status === 'unpaid') {
          await this.enforceSlotLimit(customerId, 0);
        } else if (status === 'active' || status === 'past_due') {
          // Enforce new quantity — stop connections that exceed the new limit
          await this.enforceSlotLimit(customerId, newQuantity);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as any;
        const customerId = subscription.customer as string;

        this.logger.log(`Subscription deleted: customer=${customerId}`);

        // Stop all connections for this customer
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
