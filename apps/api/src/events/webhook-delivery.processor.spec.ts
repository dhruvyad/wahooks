import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { EventMetricsService } from './event-metrics.service';

describe('WebhookDeliveryProcessor', () => {
  let processor: WebhookDeliveryProcessor;
  let db: any;
  let fetchSpy: jest.SpyInstance;
  let eventMetrics: { countDelivery: jest.Mock };

  function chainable(resolvedValue: any = undefined) {
    const chain: any = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockResolvedValue(resolvedValue),
      // webhook_configs updates (failing_since / pausing): `where` is awaited directly or ends in `returning`.
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
    };
    chain.where = jest.fn(() => Object.assign(Promise.resolve(undefined), { returning: chain.returning }));
    return chain;
  }

  function createJob(overrides: Partial<any> = {}) {
    return {
      data: {
        webhookConfigId: 'wh-config-1',
        url: 'https://hooks.example.com/webhook',
        signingSecret: 'my-secret-key',
        eventType: 'message.received',
        payload: { from: '1234567890', body: 'Hello' },
        sessionId: 'session-1',
        logId: 'log-1',
        ...overrides,
      },
      attemptsMade: 0,
      opts: { attempts: 5 },
    };
  }

  function mockFetchResponse(status = 200, ok = true, body = 'OK') {
    return {
      ok,
      status,
      text: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  beforeEach(async () => {
    db = chainable();
    eventMetrics = { countDelivery: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryProcessor,
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: EventMetricsService, useValue: eventMetrics },
      ],
    }).compile();

    processor = module.get<WebhookDeliveryProcessor>(WebhookDeliveryProcessor);

    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockFetchResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('process', () => {
    it('should send POST with correct headers', async () => {
      const job = createJob();
      fetchSpy.mockResolvedValueOnce(mockFetchResponse());

      await processor.process(job as any);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];

      expect(url).toBe('https://hooks.example.com/webhook');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['X-WAHooks-Event']).toBe('message.received');
      expect(options.headers['X-WAHooks-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(options.headers['X-WAHooks-Timestamp']).toBeDefined();
    });

    it('should generate correct HMAC-SHA256 signature over timestamp.body', async () => {
      const job = createJob();
      const bodyStr = JSON.stringify(job.data.payload);

      fetchSpy.mockResolvedValueOnce(mockFetchResponse());

      await processor.process(job as any);

      const [, options] = fetchSpy.mock.calls[0];
      const timestamp = options.headers['X-WAHooks-Timestamp'];
      const signedPayload = `${timestamp}.${bodyStr}`;
      const expectedSignature = createHmac('sha256', 'my-secret-key')
        .update(signedPayload)
        .digest('hex');

      expect(options.headers['X-WAHooks-Signature']).toBe(`sha256=${expectedSignature}`);
      expect(options.body).toBe(bodyStr);
      // Timestamp should be unix seconds (not milliseconds)
      expect(Number(timestamp)).toBeGreaterThan(1700000000);
      expect(Number(timestamp)).toBeLessThan(2000000000);
    });

    it('should mark as delivered on success', async () => {
      const job = createJob();
      fetchSpy.mockResolvedValueOnce(mockFetchResponse());

      await processor.process(job as any);

      // one write: the row is inserted when the first attempt ends
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'log-1',
          webhookConfigId: 'wh-config-1',
          eventType: 'message.received',
          payload: { from: '1234567890', body: 'Hello' },
          status: 'delivered',
          attempts: 1,
          deliveredAt: expect.any(Date),
        }),
      );
      expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({ status: 'delivered', attempts: 1, deliveredAt: expect.any(Date) }),
        }),
      );
      expect(eventMetrics.countDelivery).toHaveBeenCalledTimes(1);
      expect(eventMetrics.countDelivery).toHaveBeenCalledWith('delivered');
    });

    it('uses the time the event was queued as the row created_at', async () => {
      const job = createJob({ createdAt: '2026-11-09T10:00:00.000Z' });
      fetchSpy.mockResolvedValueOnce(mockFetchResponse());

      await processor.process(job as any);

      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: new Date('2026-11-09T10:00:00.000Z') }),
      );
    });

    it('skips the log row when the webhook was deleted while the delivery was queued', async () => {
      const job = createJob();
      fetchSpy.mockResolvedValueOnce(mockFetchResponse());
      db.onConflictDoUpdate.mockRejectedValueOnce(
        Object.assign(new Error('violates foreign key constraint'), { code: '23503' }),
      );

      await expect(processor.process(job as any)).resolves.toBeUndefined();
    });

    it('should update attempts on failure and re-throw', async () => {
      const job = createJob();
      job.attemptsMade = 1;

      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, false, 'Server Error'));

      await expect(processor.process(job as any)).rejects.toThrow('HTTP 500');

      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'log-1',
          attempts: 2,
          status: 'pending', // still under max attempts
        }),
      );
      const { set } = db.onConflictDoUpdate.mock.calls[0][0];
      expect(set).toEqual({ status: 'pending', attempts: 2 }); // a retry never touches deliveredAt
      expect(eventMetrics.countDelivery).toHaveBeenCalledTimes(1);
      expect(eventMetrics.countDelivery).toHaveBeenCalledWith('retried');
    });

    it('should mark as failed when max attempts reached', async () => {
      const job = createJob();
      job.attemptsMade = 4; // 5th attempt (0-indexed, will be +1 = 5 >= 5)
      job.opts.attempts = 5;

      fetchSpy.mockResolvedValueOnce(mockFetchResponse(502, false, 'Bad Gateway'));

      await expect(processor.process(job as any)).rejects.toThrow('HTTP 502');

      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 5,
          status: 'failed',
        }),
      );
      expect(eventMetrics.countDelivery).toHaveBeenCalledTimes(1);
      expect(eventMetrics.countDelivery).toHaveBeenCalledWith('failed');
    });

    it('counts a failed attempt even when its log row cannot be written', async () => {
      const job = createJob();
      job.attemptsMade = 4;
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, false, 'Server Error'));
      db.onConflictDoUpdate.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(processor.process(job as any)).rejects.toThrow('database unavailable');

      expect(eventMetrics.countDelivery).toHaveBeenCalledWith('failed');
    });

    it('never waits on the counter', async () => {
      eventMetrics.countDelivery.mockReturnValue(new Promise(() => undefined));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse());

      await expect(processor.process(createJob() as any)).resolves.toBeUndefined();
    });

    it('should handle network errors', async () => {
      const job = createJob();
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(processor.process(job as any)).rejects.toThrow('ECONNREFUSED');

      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 1,
          status: 'pending',
        }),
      );
    });

    it('should send the correct JSON body', async () => {
      const payload = { type: 'message', data: { text: 'Hello World' } };
      const job = createJob({ payload });
      fetchSpy.mockResolvedValueOnce(mockFetchResponse());

      await processor.process(job as any);

      const [, options] = fetchSpy.mock.calls[0];
      expect(JSON.parse(options.body)).toEqual(payload);
    });
  });
  describe('webhooks that only ever fail', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const finalAttempt = () => Object.assign(createJob(), { attemptsMade: 4 });
    const configWrites = () => db.set.mock.calls.map((c: any[]) => c[0]);

    it('a success clears the failing run, then trusts that for a while instead of writing again', async () => {
      await processor.process(createJob() as any);
      await processor.process(createJob() as any);

      expect(configWrites()).toEqual([{ failingSince: null }]);
    });

    it('a delivery that failed every retry starts the run, and a retry that may still succeed does not', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(500, false, 'down'));
      db.returning.mockResolvedValueOnce([{ failingSince: new Date(), active: true }]);

      await expect(processor.process(createJob() as any)).rejects.toThrow();
      expect(configWrites()).toHaveLength(0);

      await expect(processor.process(finalAttempt() as any)).rejects.toThrow();
      expect(configWrites()).toHaveLength(1);
      expect(configWrites()[0]).toHaveProperty('failingSince'); // coalesce(failing_since, now())
      expect(configWrites()[0]).not.toHaveProperty('active');
    });

    it('pauses the webhook once every delivery has failed for 3 days', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(500, false, 'down'));
      db.returning
        .mockResolvedValueOnce([{ failingSince: new Date(Date.now() - 3 * DAY - 1000), active: true }])
        .mockResolvedValueOnce([{ id: 'wh-config-1' }]);

      await expect(processor.process(finalAttempt() as any)).rejects.toThrow();

      expect(configWrites()[1]).toMatchObject({ active: false, pausedReason: 'failing', pausedAt: expect.any(Date) });
    });

    it('leaves it running before then, and never re-pauses one already off', async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse(500, false, 'down'));
      db.returning
        .mockResolvedValueOnce([{ failingSince: new Date(Date.now() - 2 * DAY), active: true }])
        .mockResolvedValueOnce([{ failingSince: new Date(Date.now() - 9 * DAY), active: false }]);

      await expect(processor.process(finalAttempt() as any)).rejects.toThrow();
      await expect(processor.process(finalAttempt() as any)).rejects.toThrow();

      expect(configWrites().some((w: any) => w.active === false)).toBe(false);
    });

    it('a failure forgets the cached success, so the next success clears the run again', async () => {
      await processor.process(createJob() as any);
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, false, 'down'));
      db.returning.mockResolvedValueOnce([{ failingSince: new Date(), active: true }]);
      await expect(processor.process(finalAttempt() as any)).rejects.toThrow();
      await processor.process(createJob() as any);

      expect(configWrites().filter((w: any) => w.failingSince === null)).toHaveLength(2);
    });

    it('never fails a delivery over its bookkeeping', async () => {
      db.update.mockImplementation(() => {
        throw new Error('db down');
      });
      jest.spyOn((processor as any).logger, 'warn').mockImplementation(() => undefined);

      await expect(processor.process(createJob() as any)).resolves.toBeUndefined();
    });
  });
});
