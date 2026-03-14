import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingController } from './billing.controller';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { StripeService } from './stripe.service';
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
    createCheckoutSession: jest.Mock;
    createPortalSession: jest.Mock;
    getPaidSlots: jest.Mock;
    getSubscriptionStatus: jest.Mock;
    constructWebhookEvent: jest.Mock;
  };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };

  const user = { sub: 'user-123' };

  beforeEach(async () => {
    db = createMockDb();

    stripeService = {
      createCustomer: jest.fn(),
      createCheckoutSession: jest.fn(),
      createPortalSession: jest.fn(),
      getPaidSlots: jest.fn(),
      getSubscriptionStatus: jest.fn(),
      constructWebhookEvent: jest.fn(),
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
        { provide: ConfigService, useValue: configService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BillingController>(BillingController);
  });

  describe('getStatus', () => {
    it('should return subscription status and slot info when user has existing Stripe customer', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const subscriptionStatus = {
        active: true,
        slots: 5,
        status: 'active',
        currentPeriodEnd: new Date('2026-04-01'),
        monthlyAmount: 25,
        currency: 'usd',
      };

      // First where() for ensureStripeCustomer user lookup
      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getSubscriptionStatus.mockResolvedValue(subscriptionStatus);
      // Second where() for active connections count
      db.where.mockResolvedValueOnce([{ id: 'sess-1' }, { id: 'sess-2' }]);

      const result = await controller.getStatus(user);

      expect(result).toEqual({
        subscription: {
          active: true,
          status: 'active',
          currentPeriodEnd: new Date('2026-04-01'),
          monthlyAmount: 25,
          currency: 'usd',
        },
        slots: {
          paid: 5,
          used: 2,
          available: 3,
        },
      });
      expect(stripeService.getSubscriptionStatus).toHaveBeenCalledWith('cus_existing');
    });

    it('should create a Stripe customer if user does not have one', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: null };
      const subscriptionStatus = {
        active: false,
        slots: 0,
        status: null,
        currentPeriodEnd: null,
        monthlyAmount: 0,
        currency: 'usd',
      };

      // First where() for ensureStripeCustomer - user lookup
      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCustomer.mockResolvedValue('cus_new');
      // Second where() for db.update().set().where() inside ensureStripeCustomer
      db.where.mockResolvedValueOnce(undefined);
      stripeService.getSubscriptionStatus.mockResolvedValue(subscriptionStatus);
      // Third where() for active connections count
      db.where.mockResolvedValueOnce([]);

      const result = await controller.getStatus(user);

      expect(stripeService.createCustomer).toHaveBeenCalledWith('test@example.com', 'user-123');
      expect(result).toEqual({
        subscription: {
          active: false,
          status: null,
          currentPeriodEnd: null,
          monthlyAmount: 0,
          currency: 'usd',
        },
        slots: {
          paid: 0,
          used: 0,
          available: 0,
        },
      });
    });

    it('should throw NotFoundException when user not found in database', async () => {
      db.where.mockResolvedValueOnce([]);

      await expect(controller.getStatus(user)).rejects.toThrow(NotFoundException);
    });

    it('should return zero available slots when all slots are used', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const subscriptionStatus = {
        active: true,
        slots: 2,
        status: 'active',
        currentPeriodEnd: new Date('2026-04-01'),
        monthlyAmount: 10,
        currency: 'usd',
      };

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getSubscriptionStatus.mockResolvedValue(subscriptionStatus);
      db.where.mockResolvedValueOnce([{ id: 'sess-1' }, { id: 'sess-2' }]);

      const result = await controller.getStatus(user);

      expect(result.slots).toEqual({
        paid: 2,
        used: 2,
        available: 0,
      });
    });

    it('should clamp available to zero when used exceeds paid', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const subscriptionStatus = {
        active: true,
        slots: 1,
        status: 'active',
        currentPeriodEnd: new Date('2026-04-01'),
        monthlyAmount: 5,
        currency: 'usd',
      };

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.getSubscriptionStatus.mockResolvedValue(subscriptionStatus);
      // More active connections than paid slots
      db.where.mockResolvedValueOnce([{ id: 'sess-1' }, { id: 'sess-2' }, { id: 'sess-3' }]);

      const result = await controller.getStatus(user);

      expect(result.slots.available).toBe(0);
    });
  });

  describe('createCheckout', () => {
    it('should return a Stripe checkout URL with default quantity and currency', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const checkoutUrl = 'https://checkout.stripe.com/session_abc';

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCheckoutSession.mockResolvedValue(checkoutUrl);

      const result = await controller.createCheckout(user, {});

      expect(result).toEqual({ url: checkoutUrl });
      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith(
        'cus_existing',
        1,
        'usd',
        'http://localhost:3000/billing?success=true',
        'http://localhost:3000/billing?canceled=true',
      );
    });

    it('should pass custom quantity and currency to checkout session', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: 'cus_existing' };
      const checkoutUrl = 'https://checkout.stripe.com/session_abc';

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCheckoutSession.mockResolvedValue(checkoutUrl);

      const result = await controller.createCheckout(user, { quantity: 5, currency: 'inr' });

      expect(result).toEqual({ url: checkoutUrl });
      expect(stripeService.createCheckoutSession).toHaveBeenCalledWith(
        'cus_existing',
        5,
        'inr',
        'http://localhost:3000/billing?success=true',
        'http://localhost:3000/billing?canceled=true',
      );
    });

    it('should create Stripe customer first if needed', async () => {
      const dbUser = { id: 'user-123', email: 'test@example.com', stripeCustomerId: null };
      const checkoutUrl = 'https://checkout.stripe.com/session_def';

      db.where.mockResolvedValueOnce([dbUser]);
      stripeService.createCustomer.mockResolvedValue('cus_new');
      // where() for db.update().set().where() inside ensureStripeCustomer
      db.where.mockResolvedValueOnce(undefined);
      stripeService.createCheckoutSession.mockResolvedValue(checkoutUrl);

      const result = await controller.createCheckout(user, {});

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
});
