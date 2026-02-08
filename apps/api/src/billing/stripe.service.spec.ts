import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';

// Mock the Stripe SDK
const mockStripe = {
  customers: {
    create: jest.fn(),
  },
  subscriptions: {
    create: jest.fn(),
    retrieve: jest.fn(),
    list: jest.fn(),
  },
  subscriptionItems: {
    createUsageRecord: jest.fn(),
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
          STRIPE_PRICE_ID: 'price_test_456',
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
    it('should return the session URL', async () => {
      mockStripe.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/session/test',
      });

      const result = await service.createCheckoutSession(
        'cus_123',
        'https://app.example.com/success',
        'https://app.example.com/cancel',
      );

      expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith({
        customer: 'cus_123',
        mode: 'subscription',
        line_items: [{ price: 'price_test_456' }],
        success_url: 'https://app.example.com/success',
        cancel_url: 'https://app.example.com/cancel',
      });
      expect(result).toBe('https://checkout.stripe.com/session/test');
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

  describe('createSubscription', () => {
    it('should return subscriptionId and subscriptionItemId', async () => {
      mockStripe.subscriptions.create.mockResolvedValue({
        id: 'sub_test_123',
        items: {
          data: [{ id: 'si_test_456' }],
        },
      });

      const result = await service.createSubscription('cus_test');

      expect(result).toEqual({
        subscriptionId: 'sub_test_123',
        subscriptionItemId: 'si_test_456',
      });
    });
  });

  describe('reportUsage', () => {
    it('should call createUsageRecord with correct params', async () => {
      mockStripe.subscriptionItems.createUsageRecord.mockResolvedValue({});

      await service.reportUsage('si_test', 3.5, 1700000000);

      expect(mockStripe.subscriptionItems.createUsageRecord).toHaveBeenCalledWith(
        'si_test',
        {
          quantity: 4, // Math.ceil(3.5)
          timestamp: 1700000000,
          action: 'increment',
        },
      );
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
