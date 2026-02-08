import { Test, TestingModule } from '@nestjs/testing';
import { UsageService } from './usage.service';
import { StripeService } from './stripe.service';
import { DRIZZLE_TOKEN } from '../database/database.module';

describe('UsageService', () => {
  let service: UsageService;
  let db: any;
  let stripeService: jest.Mocked<Partial<StripeService>>;

  function chainable(resolvedValue: any = []) {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(resolvedValue),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(resolvedValue),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    return chain;
  }

  beforeEach(async () => {
    db = chainable();

    stripeService = {
      reportUsage: jest.fn(),
      getCustomerSubscriptions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: StripeService, useValue: stripeService },
      ],
    }).compile();

    service = module.get<UsageService>(UsageService);
  });

  describe('recordHourlyUsage', () => {
    it('should insert usage records for active sessions', async () => {
      const activeSessions = [
        { id: 'session-1', status: 'working', userId: 'user-1' },
        { id: 'session-2', status: 'working', userId: 'user-2' },
      ];

      // First where: active sessions query
      db.where.mockResolvedValueOnce(activeSessions);
      // insert().values() for each session
      db.values
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      await service.recordHourlyUsage();

      // insert().values() should be called once per active session
      expect(db.insert).toHaveBeenCalledTimes(2);
      expect(db.values).toHaveBeenCalledTimes(2);

      // Verify the values contain the correct fields
      const firstCallArgs = db.values.mock.calls[0][0];
      expect(firstCallArgs).toMatchObject({
        sessionId: 'session-1',
        connectionHours: '1.000000',
        reportedToStripe: false,
      });
      expect(firstCallArgs.periodStart).toBeInstanceOf(Date);
      expect(firstCallArgs.periodEnd).toBeInstanceOf(Date);
    });

    it('should return early when no active sessions exist', async () => {
      db.where.mockResolvedValueOnce([]);

      await service.recordHourlyUsage();

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should handle insert errors gracefully without stopping', async () => {
      const activeSessions = [
        { id: 'session-ok', status: 'working' },
        { id: 'session-fail', status: 'working' },
      ];

      db.where.mockResolvedValueOnce(activeSessions);
      // First insert succeeds, second fails
      db.values
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('DB constraint error'));

      // Should not throw
      await expect(service.recordHourlyUsage()).resolves.not.toThrow();
    });
  });

  describe('getUserUsageSummary', () => {
    it('should calculate total hours and estimated cost', async () => {
      const userId = 'user-1';
      const sessions = [
        { id: 'session-1', status: 'working', userId },
        { id: 'session-2', status: 'stopped', userId },
      ];

      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);

      const usageForSession1 = [
        { sessionId: 'session-1', connectionHours: '10.000000', periodStart: thisMonth },
        { sessionId: 'session-1', connectionHours: '5.000000', periodStart: thisMonth },
      ];

      const usageForSession2 = [
        { sessionId: 'session-2', connectionHours: '3.000000', periodStart: thisMonth },
      ];

      // 1st where: sessions for user
      db.where.mockResolvedValueOnce(sessions);
      // 2nd where: usage records for session-1
      db.where.mockResolvedValueOnce(usageForSession1);
      // 3rd where: usage records for session-2
      db.where.mockResolvedValueOnce(usageForSession2);

      const result = await service.getUserUsageSummary(userId);

      // totalHours = 10 + 5 + 3 = 18
      expect(result.totalHours).toBe(18);
      expect(result.activeConnections).toBe(1); // only session-1 is 'working'

      // PRICE_PER_CONNECTION_HOUR = 0.25 / 720
      const expectedCost = Math.round(18 * (0.25 / 720) * 100) / 100;
      expect(result.estimatedCost).toBe(expectedCost);
    });

    it('should return zeros when user has no sessions', async () => {
      db.where.mockResolvedValueOnce([]);

      const result = await service.getUserUsageSummary('user-empty');

      expect(result).toEqual({
        totalHours: 0,
        estimatedCost: 0,
        activeConnections: 0,
      });
    });

    it('should only count usage records from the current month', async () => {
      const userId = 'user-1';
      const sessions = [{ id: 'session-1', status: 'working', userId }];

      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 10);

      const usageRecords = [
        { sessionId: 'session-1', connectionHours: '5.000000', periodStart: lastMonth },
        { sessionId: 'session-1', connectionHours: '3.000000', periodStart: thisMonth },
      ];

      db.where.mockResolvedValueOnce(sessions);
      db.where.mockResolvedValueOnce(usageRecords);

      const result = await service.getUserUsageSummary(userId);

      // Only the record from thisMonth should be counted
      expect(result.totalHours).toBe(3);
    });
  });
});
