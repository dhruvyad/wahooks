import { Controller, Post, Req, Res, Logger, Inject } from '@nestjs/common';
import { Request, Response } from 'express';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';

@Controller('stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly stripeService: StripeService,
  ) {}

  @Post('webhook')
  async handleWebhook(@Req() req: Request, @Res() res: Response) {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      this.logger.error('Missing stripe-signature header');
      return res.status(400).send('Missing stripe-signature header');
    }

    let event;
    try {
      event = this.stripeService.constructWebhookEvent(
        (req as any).rawBody, // raw body provided by NestJS rawBody option
        signature,
      );
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err}`);
      return res.status(400).send(`Webhook Error: ${err}`);
    }

    switch (event.type) {
      case 'customer.subscription.updated': {
        const subscription = event.data.object as any;
        this.logger.log(
          `Subscription ${subscription.id} updated: ${subscription.status}`,
        );

        // If subscription becomes past_due or unpaid, could suspend connections
        if (
          subscription.status === 'past_due' ||
          subscription.status === 'unpaid'
        ) {
          this.logger.warn(
            `Subscription ${subscription.id} is ${subscription.status}`,
          );
          // TODO: Send notification to user, consider suspending after grace period
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as any;
        this.logger.log(`Subscription ${subscription.id} deleted`);
        // Could stop all sessions for this customer
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        this.logger.warn(
          `Payment failed for invoice ${invoice.id}, customer ${invoice.customer}`,
        );
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as any;
        this.logger.log(
          `Invoice ${invoice.id} paid for customer ${invoice.customer}`,
        );
        break;
      }

      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }

    return res.json({ received: true });
  }
}
