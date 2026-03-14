import { Test, TestingModule } from '@nestjs/testing';
import { UsageService } from './usage.service';
import { DRIZZLE_TOKEN } from '../database/database.module';

describe('UsageService', () => {
  let service: UsageService;
  let db: any;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: DRIZZLE_TOKEN, useValue: db },
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

      db.where.mockResolvedValueOnce(activeSessions);
      db.values
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      await service.recordHourlyUsage();

      expect(db.insert).toHaveBeenCalledTimes(2);
      expect(db.values).toHaveBeenCalledTimes(2);

      const firstCallArgs = db.values.mock.calls[0][0];
      expect(firstCallArgs).toMatchObject({
        sessionId: 'session-1',
        connectionHours: '1.000000',
        reportedToStripe: true,
      });
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
      db.values
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('DB constraint error'));

      await expect(service.recordHourlyUsage()).resolves.not.toThrow();
    });
  });

  describe('getUserUsageSummary', () => {
    it('should calculate total hours and active connections', async () => {
      const userId = 'user-1';
      const sessions = [
        { id: 'session-1', status: 'working', userId },
        { id: 'session-2', status: 'stopped', userId },
      ];

      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);

      db.where.mockResolvedValueOnce(sessions);
      db.where.mockResolvedValueOnce([
        { sessionId: 'session-1', connectionHours: '10.000000', periodStart: thisMonth },
        { sessionId: 'session-1', connectionHours: '5.000000', periodStart: thisMonth },
      ]);
      db.where.mockResolvedValueOnce([
        { sessionId: 'session-2', connectionHours: '3.000000', periodStart: thisMonth },
      ]);

      const result = await service.getUserUsageSummary(userId);

      expect(result.totalHours).toBe(18);
      expect(result.activeConnections).toBe(1);
    });

    it('should return zeros when user has no sessions', async () => {
      db.where.mockResolvedValueOnce([]);

      const result = await service.getUserUsageSummary('user-empty');

      expect(result).toEqual({
        totalHours: 0,
        activeConnections: 0,
      });
    });

    it('should only count usage records from the current month', async () => {
      const userId = 'user-1';
      const sessions = [{ id: 'session-1', status: 'working', userId }];

      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 10);

      db.where.mockResolvedValueOnce(sessions);
      db.where.mockResolvedValueOnce([
        { sessionId: 'session-1', connectionHours: '5.000000', periodStart: lastMonth },
        { sessionId: 'session-1', connectionHours: '3.000000', periodStart: thisMonth },
      ]);

      const result = await service.getUserUsageSummary(userId);

      expect(result.totalHours).toBe(3);
    });
  });
});
