import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { DRIZZLE_TOKEN } from '../database/database.module';

describe('WebhookDeliveryProcessor', () => {
  let processor: WebhookDeliveryProcessor;
  let db: any;
  let fetchSpy: jest.SpyInstance;

  function chainable(resolvedValue: any = undefined) {
    const chain: any = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      onConflictDoUpdate: jest.fn().mockResolvedValue(resolvedValue),
    };
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryProcessor,
        { provide: DRIZZLE_TOKEN, useValue: db },
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
});
