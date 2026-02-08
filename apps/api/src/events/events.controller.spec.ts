import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { EventsController } from './events.controller';
import { DRIZZLE_TOKEN } from '../database/database.module';

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

describe('EventsController', () => {
  let controller: EventsController;
  let db: ReturnType<typeof createMockDb>;
  let webhookQueue: { add: jest.Mock };

  beforeEach(async () => {
    db = createMockDb();
    webhookQueue = { add: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: getQueueToken('webhook-delivery'), useValue: webhookQueue },
      ],
    }).compile();

    controller = module.get<EventsController>(EventsController);
  });

  describe('ingestWahaEvent', () => {
    it('should look up session, find matching configs, create log entries, and enqueue jobs', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config = {
        id: 'wh-1',
        sessionId: 'sess-1',
        url: 'https://example.com/hook',
        events: ['message'],
        signingSecret: 'secret-123',
        active: true,
      };
      const logEntry = { id: 'log-1' };
      const event = { event: 'message', session: 'u_user-123_s_abc', payload: { text: 'hello' } };

      // First where() is for session lookup
      db.where.mockResolvedValueOnce([session]);
      // Second where() is for webhook configs lookup
      db.where.mockResolvedValueOnce([config]);
      // returning() is for the log entry insert
      db.returning.mockResolvedValueOnce([logEntry]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(db.insert).toHaveBeenCalled();
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookConfigId: 'wh-1',
          eventType: 'message',
          payload: event,
          status: 'pending',
        }),
      );
      expect(webhookQueue.add).toHaveBeenCalledWith('deliver', {
        webhookConfigId: 'wh-1',
        url: 'https://example.com/hook',
        signingSecret: 'secret-123',
        eventType: 'message',
        payload: event,
        sessionId: 'sess-1',
        logId: 'log-1',
      });
    });

    it('should return { received: true } even when session not found', async () => {
      db.where.mockResolvedValueOnce([]);

      const result = await controller.ingestWahaEvent({
        event: 'message',
        session: 'nonexistent-session',
      });

      expect(result).toEqual({ received: true });
      expect(webhookQueue.add).not.toHaveBeenCalled();
    });

    it('should handle wildcard * event matching', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const wildcardConfig = {
        id: 'wh-wildcard',
        sessionId: 'sess-1',
        url: 'https://example.com/all-events',
        events: ['*'],
        signingSecret: 'secret-wildcard',
        active: true,
      };
      const logEntry = { id: 'log-wildcard' };
      const event = { event: 'session.status', session: 'u_user-123_s_abc', payload: { status: 'WORKING' } };

      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([wildcardConfig]);
      db.returning.mockResolvedValueOnce([logEntry]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(webhookQueue.add).toHaveBeenCalledWith('deliver', expect.objectContaining({
        webhookConfigId: 'wh-wildcard',
        eventType: 'session.status',
      }));
    });

    it('should not enqueue jobs when no configs match the event type', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config = {
        id: 'wh-1',
        sessionId: 'sess-1',
        url: 'https://example.com/hook',
        events: ['message'],
        signingSecret: 'secret-123',
        active: true,
      };
      const event = { event: 'session.status', session: 'u_user-123_s_abc' };

      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([config]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(webhookQueue.add).not.toHaveBeenCalled();
    });

    it('should enqueue multiple jobs when multiple configs match', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config1 = {
        id: 'wh-1',
        sessionId: 'sess-1',
        url: 'https://example.com/hook1',
        events: ['message'],
        signingSecret: 'secret-1',
        active: true,
      };
      const config2 = {
        id: 'wh-2',
        sessionId: 'sess-1',
        url: 'https://example.com/hook2',
        events: ['*'],
        signingSecret: 'secret-2',
        active: true,
      };
      const logEntry1 = { id: 'log-1' };
      const logEntry2 = { id: 'log-2' };
      const event = { event: 'message', session: 'u_user-123_s_abc', payload: { text: 'hi' } };

      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([config1, config2]);
      db.returning.mockResolvedValueOnce([logEntry1]);
      db.returning.mockResolvedValueOnce([logEntry2]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(webhookQueue.add).toHaveBeenCalledTimes(2);
      expect(webhookQueue.add).toHaveBeenCalledWith('deliver', expect.objectContaining({
        webhookConfigId: 'wh-1',
        logId: 'log-1',
      }));
      expect(webhookQueue.add).toHaveBeenCalledWith('deliver', expect.objectContaining({
        webhookConfigId: 'wh-2',
        logId: 'log-2',
      }));
    });
  });
});
