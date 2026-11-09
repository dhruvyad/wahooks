import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { EventsController } from './events.controller';
import { eventsSecretMatches } from './events-secret';
import { EventsGateway } from './events.gateway';
import { WebhookLogRetentionService } from './webhook-log-retention.service';
import { EventMetricsService } from './event-metrics.service';
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
  let eventMetrics: { countReceived: jest.Mock };

  beforeEach(async () => {
    db = createMockDb();
    webhookQueue = { add: jest.fn().mockResolvedValue({}) };
    logRetention = { touch: jest.fn() };
    eventMetrics = { countReceived: jest.fn().mockResolvedValue(undefined) };
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
        { provide: EventMetricsService, useValue: eventMetrics },
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
      // Counted once for the event volume graphs, by its type.
      expect(eventMetrics.countReceived).toHaveBeenCalledTimes(1);
      expect(eventMetrics.countReceived).toHaveBeenCalledWith('message');
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
      // Only events for a known connection are counted.
      expect(eventMetrics.countReceived).not.toHaveBeenCalled();
    });

    it('counts an event that no webhook wants, and never waits on the counter', async () => {
      const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123' };
      db.where.mockResolvedValueOnce([session]).mockResolvedValueOnce([]);
      // A counter stuck on Redis must not hold the request.
      eventMetrics.countReceived.mockReturnValue(new Promise(() => undefined));

      await expect(
        controller.ingestWahaEvent({ event: 'presence.update', session: 'u_user-123_s_abc' }),
      ).resolves.toEqual({ received: true });
      expect(eventMetrics.countReceived).toHaveBeenCalledWith('presence.update');
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

    it('never brings a deleted (stopped) connection back on a late session.status event', async () => {
      for (const status of ['WORKING', 'SCAN_QR_CODE', 'FAILED']) {
        db.update.mockClear();
        const session = { id: 'sess-1', sessionName: 'u_user-123_s_abc', userId: 'user-123', status: 'stopped', phoneNumber: '1234567890' };
        db.where.mockResolvedValueOnce([session]); // session lookup
        db.where.mockResolvedValueOnce([]); // webhook configs lookup (none)
        await controller.ingestWahaEvent({ event: 'session.status', session: 'u_user-123_s_abc', payload: { status } });
        expect(db.update).not.toHaveBeenCalled();
      }
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

  describe('events secret', () => {
    const SECRET = 'test-events-secret';
    const gatewaySession = { id: 'sess-g', sessionName: 'u_g_s_1', userId: 'user-1', workerId: 'gw-1', status: 'working' };
    const wahaSession = { id: 'sess-w', sessionName: 'u_w_s_1', userId: 'user-1', workerId: 'w-0', status: 'working' };
    const hook = { id: 'wh-1', url: 'https://example.com/hook', events: ['*'], signingSecret: 's', active: true };
    let kinds: { getWorkerKind: jest.Mock; getWorkerForSession: jest.Mock };
    let warn: jest.SpyInstance;

    /** A controller with this EVENTS_SECRET (or none). */
    function make(secret?: string) {
      kinds = {
        getWorkerKind: jest.fn(async (id: string) => (id.startsWith('gw') ? 'gateway' : 'waha')),
        getWorkerForSession: jest.fn(),
      };
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const values: Record<string, string> = { API_URL: 'http://localhost:3001', ...(secret ? { EVENTS_SECRET: secret } : {}) };
      return new EventsController(
        db,
        webhookQueue as any,
        wahaService as any,
        kinds as any,
        { broadcastEvent: jest.fn() } as any,
        { get: jest.fn((key: string, def?: unknown) => (key in values ? values[key] : def)) } as any,
        logRetention as any,
        eventMetrics as any,
      );
    }
    const event = (session: string) => ({ event: 'message', session, payload: { body: 'hi' } });

    afterEach(() => jest.restoreAllMocks());

    it('refuses a gateway session that sends no secret, and names the session', async () => {
      const ctrl = make(SECRET);
      db.where.mockResolvedValueOnce([gatewaySession]);

      await expect(ctrl.ingestWahaEvent(event('u_g_s_1'))).rejects.toThrow(UnauthorizedException);

      expect(webhookQueue.add).not.toHaveBeenCalled();
      expect(eventMetrics.countReceived).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"u_g_s_1"'));
    });

    it('accepts a gateway session that sends the secret', async () => {
      const ctrl = make(SECRET);
      db.where.mockResolvedValueOnce([gatewaySession]).mockResolvedValueOnce([hook]);

      await expect(ctrl.ingestWahaEvent(event('u_g_s_1'), SECRET)).resolves.toEqual({ received: true });

      expect(webhookQueue.add).toHaveBeenCalledTimes(1);
      // A sent secret already proves the caller: no kind lookup needed.
      expect(kinds.getWorkerKind).not.toHaveBeenCalled();
    });

    it('refuses a wrong secret from anyone, before looking anything up', async () => {
      const ctrl = make(SECRET);

      await expect(ctrl.ingestWahaEvent(event('u_w_s_1'), 'test-events-secreT')).rejects.toThrow(UnauthorizedException);
      await expect(ctrl.ingestWahaEvent(event('u_w_s_1'), '')).rejects.toThrow(UnauthorizedException);

      expect(db.where).not.toHaveBeenCalled();
      expect(eventMetrics.countReceived).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"u_w_s_1"'));
    });

    it('accepts a WAHA session without the header, as before', async () => {
      const ctrl = make(SECRET);
      db.where.mockResolvedValueOnce([wahaSession]).mockResolvedValueOnce([hook]);

      await expect(ctrl.ingestWahaEvent(event('u_w_s_1'))).resolves.toEqual({ received: true });
      expect(webhookQueue.add).toHaveBeenCalledTimes(1);
    });

    it("looks the worker's kind up in the cache, not with a query per event", async () => {
      const ctrl = make(SECRET);
      db.where.mockResolvedValueOnce([wahaSession]).mockResolvedValueOnce([hook]);

      await ctrl.ingestWahaEvent(event('u_w_s_1'));

      expect(kinds.getWorkerKind).toHaveBeenCalledWith('w-0');
      // The session row and its webhook configs: the queries this endpoint always made.
      expect(db.where).toHaveBeenCalledTimes(2);
    });

    it('without EVENTS_SECRET: accepts as before, and warns once at boot', async () => {
      const ctrl = make();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVENTS_SECRET is not set'));
      db.where.mockResolvedValueOnce([gatewaySession]).mockResolvedValueOnce([hook]);

      await expect(ctrl.ingestWahaEvent(event('u_g_s_1'))).resolves.toEqual({ received: true });
      await expect(
        (async () => {
          db.where.mockResolvedValueOnce([gatewaySession]).mockResolvedValueOnce([hook]);
          return ctrl.ingestWahaEvent(event('u_g_s_1'), 'anything');
        })(),
      ).resolves.toEqual({ received: true });
      expect(kinds.getWorkerKind).not.toHaveBeenCalled();
      expect(warn.mock.calls.filter(([m]) => String(m).includes('EVENTS_SECRET'))).toHaveLength(1);
    });
  });

  describe('eventsSecretMatches', () => {
    it('compares in constant time over any length', () => {
      expect(eventsSecretMatches('abc', 'abc')).toBe(true);
      expect(eventsSecretMatches('abd', 'abc')).toBe(false);
      expect(eventsSecretMatches('abcd', 'abc')).toBe(false);
      expect(eventsSecretMatches('', 'abc')).toBe(false);
    });
  });

  describe('createSession on a gateway', () => {
    it("carries the events secret in the WAHooks webhook's customHeaders", () => {
      const waha = new WahaService({ get: (key: string, def?: unknown) => (key === 'EVENTS_SECRET' ? 'test-events-secret' : def) } as any);
      expect(waha.eventsWebhook('https://api.example.com/api/events/waha', 'gateway')).toEqual({
        url: 'https://api.example.com/api/events/waha',
        events: ['*'],
        customHeaders: [{ name: 'X-WAHooks-Events-Secret', value: 'test-events-secret' }],
      });
      // WAHA sessions are created as before.
      expect(waha.eventsWebhook('https://api.example.com/api/events/waha', 'waha')).toEqual({
        url: 'https://api.example.com/api/events/waha',
        events: ['*'],
      });
    });
  });
});
