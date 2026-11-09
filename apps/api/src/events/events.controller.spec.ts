import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { EventsController } from './events.controller';
import { EventsGateway } from './events.gateway';
import { WebhookLogRetentionService } from './webhook-log-retention.service';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { WahaService } from '../waha/waha.service';
import { WorkersService } from '../workers/workers.service';

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
  let wahaService: { getMaxSessions: jest.Mock; resolveSessionName: jest.Mock; getLidPhoneChat: jest.Mock };
  let workersService: { getWorkerForSession: jest.Mock };
  let logRetention: { touch: jest.Mock };

  beforeEach(async () => {
    db = createMockDb();
    webhookQueue = { add: jest.fn().mockResolvedValue({}) };
    logRetention = { touch: jest.fn() };
    wahaService = {
      getMaxSessions: jest.fn().mockReturnValue(2),
      resolveSessionName: jest.fn((name: string) => name),
      getLidPhoneChat: jest.fn().mockResolvedValue(null),
    };
    workersService = {
      getWorkerForSession: jest.fn().mockResolvedValue({ id: 'w-1', internalIp: '10.0.0.1', apiKeyEnc: 'k' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: getQueueToken('webhook-delivery'), useValue: webhookQueue },
        { provide: WahaService, useValue: wahaService },
        { provide: WorkersService, useValue: workersService },
        { provide: EventsGateway, useValue: { broadcastEvent: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('http://localhost:3001') } },
        { provide: WebhookLogRetentionService, useValue: logRetention },
      ],
    }).compile();

    controller = module.get<EventsController>(EventsController);
  });

  describe('ingestWahaEvent', () => {
    it('should look up session, find matching configs, and enqueue jobs whose log rows the processor writes', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config = {
        id: 'wh-1',
        sessionId: 'sess-1',
        url: 'https://example.com/hook',
        events: ['message'],
        signingSecret: 'secret-123',
        active: true,
      };
      const event = { event: 'message', session: 'u_user-123_s_abc', payload: { text: 'hello' } };

      // First where() is for session lookup
      db.where.mockResolvedValueOnce([session]);
      // Second where() is for webhook configs lookup
      db.where.mockResolvedValueOnce([config]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      // No log row at ingest: the delivery processor writes it when the first attempt ends.
      expect(db.insert).not.toHaveBeenCalled();
      // Delivered envelopes carry connectionId so consumers can map events to
      // the connection they registered against (session names are internal).
      const delivered = { ...event, connectionId: 'sess-1' };
      expect(webhookQueue.add).toHaveBeenCalledWith('deliver', {
        webhookConfigId: 'wh-1',
        url: 'https://example.com/hook',
        signingSecret: 'secret-123',
        eventType: 'message',
        payload: delivered,
        sessionId: 'sess-1',
        logId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        createdAt: expect.any(String),
      });
      expect(logRetention.touch).toHaveBeenCalledWith('wh-1');
    });

    it('resolves a @lid sender into a top-level payload.senderPhone (leaving from/_data intact)', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config = {
        id: 'wh-1', sessionId: 'sess-1', url: 'https://example.com/hook',
        events: ['message'], signingSecret: 'secret-123', active: true,
      };
      const event = {
        event: 'message',
        session: 'u_user-123_s_abc',
        payload: {
          from: '171051518537926@lid',
          body: 'oi',
          _data: {
            key: {
              remoteJid: '171051518537926@lid',
              remoteJidAlt: '556291503777@s.whatsapp.net',
            },
          },
        },
      };

      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([config]);
      db.returning.mockResolvedValueOnce([{ id: 'log-1' }]);

      await controller.ingestWahaEvent(event);

      const delivered = webhookQueue.add.mock.calls[0][1].payload;
      // New convenience field: real phone number, digits only.
      expect(delivered.payload.senderPhone).toBe('556291503777');
      // Backwards compatibility: original fields untouched.
      expect(delivered.payload.from).toBe('171051518537926@lid');
      expect(delivered.payload._data.key.remoteJidAlt).toBe('556291503777@s.whatsapp.net');
      expect(delivered.connectionId).toBe('sess-1');
    });

    it('sets senderPhone from a plain phone `from`, and null when nothing names the LID sender\'s phone', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config = {
        id: 'wh-1', sessionId: 'sess-1', url: 'https://example.com/hook',
        events: ['message'], signingSecret: 'secret-123', active: true,
      };

      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([config]);
      db.returning.mockResolvedValueOnce([{ id: 'log-1' }]);
      await controller.ingestWahaEvent({
        event: 'message', session: 'u_user-123_s_abc',
        payload: { from: '556299999999@c.us', body: 'hi' },
      });
      expect(webhookQueue.add.mock.calls[0][1].payload.payload.senderPhone).toBe('556299999999');

      webhookQueue.add.mockClear();
      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([config]);
      db.returning.mockResolvedValueOnce([{ id: 'log-2' }]);
      await controller.ingestWahaEvent({
        event: 'message', session: 'u_user-123_s_abc',
        payload: { from: '171051518537926@lid', body: 'hi' }, // no phone JID, and the LID store answers pn: null
      });
      expect(webhookQueue.add.mock.calls[0][1].payload.payload.senderPhone).toBeNull();
    });

    describe('LID senders WhatsApp ships without a phone JID', () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      const config = {
        id: 'wh-1', sessionId: 'sess-1', url: 'https://example.com/hook',
        events: ['message'], signingSecret: 'secret-123', active: true,
      };
      const lidMessage = (extra: Record<string, unknown> = {}) => ({
        event: 'message',
        session: 'u_user-123_s_abc',
        payload: {
          from: '171051518537926@lid',
          fromMe: false,
          body: 'hi',
          _data: { key: { remoteJid: '171051518537926@lid', addressingMode: 'lid', participant: '' } },
          ...extra,
        },
      });

      async function deliver(event: any) {
        webhookQueue.add.mockClear();
        db.where.mockResolvedValueOnce([session]);
        db.where.mockResolvedValueOnce([config]);
        db.returning.mockResolvedValueOnce([{ id: 'log-1' }]);
        await controller.ingestWahaEvent(event);
        return webhookQueue.add.mock.calls[0][1].payload.payload;
      }

      it('asks the session LID store and caches the pair', async () => {
        wahaService.getLidPhoneChat.mockResolvedValue('556291503777@c.us');

        expect((await deliver(lidMessage())).senderPhone).toBe('556291503777');
        expect(wahaService.getLidPhoneChat).toHaveBeenCalledWith(
          '10.0.0.1', 'k', 'u_user-123_s_abc', '171051518537926@lid',
        );
        // A second message from the same writer is answered from the cache.
        expect((await deliver(lidMessage())).senderPhone).toBe('556291503777');
        expect(wahaService.getLidPhoneChat).toHaveBeenCalledTimes(1);
      });

      it('looks up a group writer by its participant LID', async () => {
        wahaService.getLidPhoneChat.mockResolvedValue('556291503777@c.us');
        const delivered = await deliver(lidMessage({
          from: '120363000000000001@g.us',
          participant: '171051518537926@lid',
        }));
        expect(delivered.senderPhone).toBe('556291503777');
        expect(wahaService.getLidPhoneChat.mock.calls[0][3]).toBe('171051518537926@lid');
      });

      it('keeps senderPhone null when the lookup fails, and asks again next time', async () => {
        wahaService.getLidPhoneChat.mockRejectedValueOnce(new Error('WAHA API timeout'));
        expect((await deliver(lidMessage())).senderPhone).toBeNull();

        wahaService.getLidPhoneChat.mockResolvedValueOnce('556291503777@c.us');
        expect((await deliver(lidMessage())).senderPhone).toBe('556291503777');
        expect(wahaService.getLidPhoneChat).toHaveBeenCalledTimes(2);
      });

      it('never reads a phone number out of the LID digits', async () => {
        wahaService.getLidPhoneChat.mockResolvedValue('171051518537926@lid');
        expect((await deliver(lidMessage())).senderPhone).toBeNull();
      });

      it('skips the lookup for the account\'s own messages and when the alt JID is there', async () => {
        await deliver(lidMessage({ fromMe: true }));
        expect((await deliver(lidMessage({
          _data: { key: { remoteJid: '171051518537926@lid', remoteJidAlt: '556291503777@s.whatsapp.net' } },
        }))).senderPhone).toBe('556291503777');
        expect(wahaService.getLidPhoneChat).not.toHaveBeenCalled();
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
      // session.status WORKING on a non-working session triggers a DB status update
      db.where.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([wildcardConfig]);
      db.returning.mockResolvedValueOnce([logEntry]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(webhookQueue.add).toHaveBeenCalledWith('deliver', expect.objectContaining({
        webhookConfigId: 'wh-wildcard',
        eventType: 'session.status',
      }));
    });

    it('should update DB status immediately on a session.status WORKING event', async () => {
      const session = {
        id: 'sess-1',
        sessionName: 'u_user-123_s_abc',
        userId: 'user-123',
        status: 'scan_qr',
        phoneNumber: null,
      };
      const event = {
        event: 'session.status',
        session: 'u_user-123_s_abc',
        payload: { status: 'WORKING', me: { id: '1234567890@c.us' } },
      };

      db.where.mockResolvedValueOnce([session]); // session lookup
      db.where.mockResolvedValueOnce([]); // applySessionStatus update
      db.where.mockResolvedValueOnce([]); // webhook configs lookup (none)

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'working', phoneNumber: '1234567890' }),
      );
    });

    it('should not write to DB when session.status matches current DB status', async () => {
      const session = {
        id: 'sess-1',
        sessionName: 'u_user-123_s_abc',
        userId: 'user-123',
        status: 'working',
        phoneNumber: '1234567890',
      };
      const event = {
        event: 'session.status',
        session: 'u_user-123_s_abc',
        payload: { status: 'WORKING', me: { id: '1234567890@c.us' } },
      };

      db.where.mockResolvedValueOnce([session]); // session lookup
      db.where.mockResolvedValueOnce([]); // webhook configs lookup (none)

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(db.update).not.toHaveBeenCalled();
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
      const event = { event: 'message', session: 'u_user-123_s_abc', payload: { text: 'hi' } };

      db.where.mockResolvedValueOnce([session]);
      db.where.mockResolvedValueOnce([config1, config2]);

      const result = await controller.ingestWahaEvent(event);

      expect(result).toEqual({ received: true });
      expect(webhookQueue.add).toHaveBeenCalledTimes(2);
      const [, job1] = webhookQueue.add.mock.calls[0];
      const [, job2] = webhookQueue.add.mock.calls[1];
      expect(job1).toEqual(expect.objectContaining({ webhookConfigId: 'wh-1' }));
      expect(job2).toEqual(expect.objectContaining({ webhookConfigId: 'wh-2' }));
      // each delivery gets its own log row id
      expect(job1.logId).not.toEqual(job2.logId);
      expect(logRetention.touch).toHaveBeenCalledWith('wh-1');
      expect(logRetention.touch).toHaveBeenCalledWith('wh-2');
    });
  });
});
