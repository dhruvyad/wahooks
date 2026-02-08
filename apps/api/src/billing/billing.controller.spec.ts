import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingController } from './billing.controller';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';
import { UsageService } from './usage.service';
import { AuthGuard } from '../auth/auth.guard';

function createMockDb() {
  const mock: any = {};
  mock.select = jest.fn().mockReturnValue(mock);
  mock.from = jest.fn().mockReturnValue(mock);
  mock.where = jest.fn().mockReturnValue(mock);
  mock.insert = jest.fn().mockReturnValue(mock);
  mock.values = jest.fn().mockReturnValue(mock);
  mock.returning = jest.fn().mockResolvedValue([]);
  mock.update = jest.fn().mockReturnValue(mock);
  mock.set = jest.fn().mockReturnValue(mock);
  mock.delete = jest.fn().mockReturnValue(mock);
  mock.orderBy = jest.fn().mockReturnValue(mock);
  mock.limit = jest.fn().mockResolvedValue([]);
  mock.and = jest.fn().mockReturnValue(mock);
  return mock;
}

describe('BillingController', () => {
  let controller: BillingController;
  let db: ReturnType<typeof createMockDb>;
  let stripeService: {
    createCustomer: jest.Mock;
    getCustomerSubscriptions: jest.Mock;
    createCheckoutSession: jest.Mock;
    createPortalSession: jest.Mock;
  };
  let usageService: { getUserUsageSummary: jest.Mock };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };

  const user = { sub: 'user-123' };

  beforeEach(async () => {
    db = createMockDb();

    stripeService = {
      createCustomer: jest.fn(),
      getCustomerSubscriptions: jest.fn(),
      createCheckoutSession: jest.fn(),
      createPortalSession: jest.fn(),
    };

    usageService = {
      getUserUsageSummary: jest.fn(),
    };

    configService = {
      get: jest.fn().mockReturnValue('http://localhost:3000'),
      getOrThrow: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: StripeService, useValue: stripeService },
        { provide: UsageService, useValue: usageService },
        { provide: ConfigService, useValue: configService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BillingController>(BillingController);
  });

  describe('getStatus', () => {
    it('should return subscription status and usage summary when user has existing Stripe customer', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const subscriptions = [
        { status: 'active', id: 'sub_1' },
      ];
      const usageSummary = { totalHours: 10, estimatedCost: 0.03, activeConnections: 2 };

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getCustomerSubscriptions.mockResolvedValue(subscriptions);
      usageService.getUserUsageSummary.mockResolvedValue(usageSummary);

      const result = await controller.getStatus(user);

      expect(result).toEqual({
        hasPaymentMethod: true,
        subscriptionStatus: 'active',
        usage: usageSummary,
      });
      expect(stripeService.getCustomerSubscriptions).toHaveBeenCalledWith('cus_existing');
      expect(usageService.getUserUsageSummary).toHaveBeenCalledWith('user-123');
    });

    it('should create a Stripe customer if user does not have one', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: null };
      const usageSummary = { totalHours: 0, estimatedCost: 0, activeConnections: 0 };

      // First where() for ensureStripeCustomer - user lookup
      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCustomer.mockResolvedValue('cus_new');
      stripeService.getCustomerSubscriptions.mockResolvedValue([]);
      usageService.getUserUsageSummary.mockResolvedValue(usageSummary);

      const result = await controller.getStatus(user);

      expect(stripeService.createCustomer).toHaveBeenCalledWith('test@example.com', 'user-123');
      expect(result).toEqual({
        hasPaymentMethod: false,
        subscriptionStatus: null,
        usage: usageSummary,
      });
    });

    it('should throw NotFoundException when user not found in database', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(controller.getStatus(user)).rejects.toThrow(NotFoundException);
    });

    it('should return null subscriptionStatus when no active subscription exists', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const subscriptions = [
        { status: 'canceled', id: 'sub_1' },
      ];
      const usageSummary = { totalHours: 5, estimatedCost: 0.02, activeConnections: 1 };

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getCustomerSubscriptions.mockResolvedValue(subscriptions);
      usageService.getUserUsageSummary.mockResolvedValue(usageSummary);

      const result = await controller.getStatus(user);

      expect(result).toEqual({
        hasPaymentMethod: false,
        subscriptionStatus: null,
        usage: usageSummary,
      });
    });

    it('should recognize trialing and past_due as active subscription statuses', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const usageSummary = { totalHours: 0, estimatedCost: 0, activeConnections: 0 };

      // Test trialing
      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getCustomerSubscriptions.mockResolvedValue([{ status: 'trialing', id: 'sub_trial' }]);
      usageService.getUserUsageSummary.mockResolvedValue(usageSummary);

      const result = await controller.getStatus(user);
      expect(result.subscriptionStatus).toBe('trialing');
      expect(result.hasPaymentMethod).toBe(true);
    });
  });

  describe('createCheckout', () => {
    it('should return a Stripe checkout URL', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const checkoutUrl = 'https://checkout.stripe.com/session_abc';

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCheckoutSession.mockResolvedValue(checkoutUrl);

      const result = await controller.createCheckout(user);

      expect(result).toEqual({ url: checkoutUrl });
      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith(
        'cus_existing',
        'http://localhost:3000/billing?success=true',
        'http://localhost:3000/billing?canceled=true',
      );
    });

    it('should create Stripe customer first if needed', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: null };
      const checkoutUrl = 'https://checkout.stripe.com/session_def';

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCustomer.mockResolvedValue('cus_new');
      stripeService.createCheckoutSession.mockResolvedValue(checkoutUrl);

      const result = await controller.createCheckout(user);

      expect(stripeService.createCustomer).toHaveBeenCalledWith('test@example.com', 'user-123');
      expect(result).toEqual({ url: checkoutUrl });
    });
  });

  describe('createPortal', () => {
    it('should return a Stripe portal URL', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const portalUrl = 'https://billing.stripe.com/portal_abc';

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createPortalSession.mockResolvedValue(portalUrl);

      const result = await controller.createPortal(user);

      expect(result).toEqual({ url: portalUrl });
      expect(stripeService.createPortalSession).toHaveBeenCalledWith(
        'cus_existing',
        'http://localhost:3000/billing',
      );
    });
  });

  describe('getUsage', () => {
    it('should return usage summary from UsageService', async () => {
      const usageSummary = { totalHours: 42.5, estimatedCost: 0.15, activeConnections: 3 };
      usageService.getUserUsageSummary.mockResolvedValue(usageSummary);

      const result = await controller.getUsage(user);

      expect(result).toEqual(usageSummary);
      expect(usageService.getUserUsageSummary).toHaveBeenCalledWith('user-123');
    });
  });
});
