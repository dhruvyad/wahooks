import { Controller, Post, Req, Res, Logger, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';

// Minimal types for Express req/res — avoids importing @types/express
// which adds a global Response type that conflicts with fetch's Response
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
    @Inject(DRIZZLE_TOKEN) private readonly db: unknown,
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

    switch (event.type) {
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        this.logger.log(
          `Subscription ${subscription.id} updated: ${'status' in subscription ? subscription.status : 'unknown'}`,
        );

        if (
          'status' in subscription &&
          (subscription.status === 'past_due' ||
            subscription.status === 'unpaid')
        ) {
          this.logger.warn(
            `Subscription ${subscription.id} is ${subscription.status}`,
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        this.logger.log(`Subscription ${subscription.id} deleted`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        this.logger.warn(
          `Payment failed for invoice ${invoice.id}, customer ${'customer' in invoice ? invoice.customer : 'unknown'}`,
        );
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        this.logger.log(
          `Invoice ${invoice.id} paid for customer ${'customer' in invoice ? invoice.customer : 'unknown'}`,
        );
        break;
      }

      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }

    return res.json({ received: true });
  }
}
