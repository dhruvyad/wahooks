import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';

// Mock the Stripe SDK
const mockStripe = {
  customers: {
    create: jest.fn(),
  },
  subscriptions: {
    list: jest.fn(),
    update: jest.fn(),
  },
  checkout: {
    sessions: {
      create: jest.fn(),
    },
  },
  billingPortal: {
    sessions: {
      create: jest.fn(),
    },
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
};

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => mockStripe);
});

describe('StripeService', () => {
  let service: StripeService;
  let configService: Partial<ConfigService>;

  beforeEach(async () => {
    // Reset all mocks before each test
    jest.clearAllMocks();

    configService = {
      get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
        const config: Record<string, string> = {
          STRIPE_SECRET_KEY: 'sk_test_123',
          STRIPE_USD_PRICE_ID: 'price_usd_456',
          STRIPE_INR_PRICE_ID: 'price_inr_789',
          STRIPE_WEBHOOK_SECRET: 'whsec_test_789',
        };
        return config[key] ?? defaultValue ?? '';
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<StripeService>(StripeService);
  });

  describe('createCustomer', () => {
    it('should call stripe.customers.create with email and metadata', async () => {
      mockStripe.customers.create.mockResolvedValue({
        id: 'cus_test_abc',
        email: 'user@example.com',
      });

      const result = await service.createCustomer('user@example.com', 'user-id-1');

      expect(mockStripe.customers.create).toHaveBeenCalledWith({
        email: 'user@example.com',
        metadata: { wahooks_user_id: 'user-id-1' },
      });
      expect(result).toBe('cus_test_abc');
    });

    it('should propagate errors from Stripe', async () => {
      mockStripe.customers.create.mockRejectedValue(new Error('Stripe error'));

      await expect(
        service.createCustomer('fail@example.com', 'user-2'),
      ).rejects.toThrow('Stripe error');
    });
  });

  describe('createCheckoutSession', () => {
    it('should create a new checkout session when no active subscription exists', async () => {
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session/test',
      });

      const result = await service.createCheckoutSession(
        'cus_123',
        2,
        'usd',
        'https://app.example.com/success',
        'https://app.example.com/cancel',
      );

      expect(mockStripe.subscriptions.list).toHaveBeenCalledWith({
        customer: 'cus_123',
        status: 'active',
        limit: 1,
      });
      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_123',
        mode: 'subscription',
        line_items: [{ price: 'price_usd_456', quantity: 2 }],
        success_url: 'https://app.example.com/success',
        cancel_url: 'https://app.example.com/cancel',
      });
      expect(result).toBe('https://checkout.stripe.com/session/test');
    });

    it('should use INR price ID when currency is inr', async () => {
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session/inr',
      });

      await service.createCheckoutSession(
        'cus_123',
        1,
        'inr',
        'https://app.example.com/success',
        'https://app.example.com/cancel',
      );

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: 'price_inr_789', quantity: 1 }],
        }),
      );
    });

    it('should update existing subscription quantity when active subscription exists', async () => {
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_existing',
          items: {
            data: [{ id: 'si_existing', quantity: 3 }],
          },
        }],
      });
      mockStripe.subscriptions.update.mockResolvedValue({});

      const result = await service.createCheckoutSession(
        'cus_123',
        2,
        'usd',
        'https://app.example.com/success',
        'https://app.example.com/cancel',
      );

      expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_existing', {
        items: [{
          id: 'si_existing',
          quantity: 5, // 3 + 2
        }],
        proration_behavior: 'create_prorations',
      });
      // Should return success URL directly (no checkout needed)
      expect(result).toBe('https://app.example.com/success');
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    });
  });

  describe('getPaidSlots', () => {
    it('should return quantity from active subscription', async () => {
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_1',
          items: { data: [{ quantity: 5 }] },
        }],
      });

      const result = await service.getPaidSlots('cus_123');

      expect(result).toBe(5);
      expect(mockStripe.subscriptions.list).toHaveBeenCalledWith({
        customer: 'cus_123',
        status: 'active',
        limit: 1,
      });
    });

    it('should return 0 when no active subscription exists', async () => {
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });

      const result = await service.getPaidSlots('cus_123');

      expect(result).toBe(0);
    });
  });

  describe('getSubscriptionStatus', () => {
    it('should return subscription details when subscription exists', async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 86400;
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_1',
          status: 'active',
          current_period_end: periodEnd,
          items: {
            data: [{
              quantity: 3,
              price: { unit_amount: 500, currency: 'usd' },
            }],
          },
        }],
      });

      const result = await service.getSubscriptionStatus('cus_123');

      expect(result).toEqual({
        active: true,
        slots: 3,
        status: 'active',
        currentPeriodEnd: new Date(periodEnd * 1000),
        monthlyAmount: 15, // (500 * 3) / 100
        currency: 'usd',
      });
    });

    it('should return inactive status when no subscription exists', async () => {
      mockStripe.subscriptions.list.mockResolvedValue({ data: [] });

      const result = await service.getSubscriptionStatus('cus_123');

      expect(result).toEqual({
        active: false,
        slots: 0,
        status: null,
        currentPeriodEnd: null,
        monthlyAmount: 0,
        currency: 'usd',
      });
    });

    it('should return active=false for non-active subscription statuses', async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 86400;
      mockStripe.subscriptions.list.mockResolvedValue({
        data: [{
          id: 'sub_1',
          status: 'past_due',
          current_period_end: periodEnd,
          items: {
            data: [{
              quantity: 2,
              price: { unit_amount: 500, currency: 'usd' },
            }],
          },
        }],
      });

      const result = await service.getSubscriptionStatus('cus_123');

      expect(result.active).toBe(false);
      expect(result.status).toBe('past_due');
      expect(result.slots).toBe(2);
    });
  });

  describe('constructWebhookEvent', () => {
    it('should call stripe.webhooks.constructEvent with correct args', () => {
      const fakeEvent = { id: 'evt_test', type: 'customer.subscription.created' };
      mockStripe.webhooks.constructEvent.mockReturnValue(fakeEvent);

      const body = Buffer.from('raw body');
      const signature = 'sig_test';

      const result = service.constructWebhookEvent(body, signature);

      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
        body,
        signature,
        'whsec_test_789',
      );
      expect(result).toEqual(fakeEvent);
    });

    it('should propagate signature verification errors', () => {
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('Webhook signature verification failed');
      });

      expect(() =>
        service.constructWebhookEvent(Buffer.from('bad'), 'invalid-sig'),
      ).toThrow('Webhook signature verification failed');
    });
  });

  describe('createPortalSession', () => {
    it('should return the portal session URL', async () => {
      mockStripe.billingPortal.sessions.create.mockResolvedValue({
        url: 'https://billing.stripe.com/portal/test',
      });

      const result = await service.createPortalSession('cus_123', 'https://app.example.com');

      expect(result).toBe('https://billing.stripe.com/portal/test');
    });
  });
});
