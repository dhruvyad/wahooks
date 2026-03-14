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
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(resolvedValue),
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

      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'delivered',
          attempts: 1,
        }),
      );
    });

    it('should update attempts on failure and re-throw', async () => {
      const job = createJob();
      job.attemptsMade = 1;

      fetchSpy.mockResolvedValueOnce(mockFetchResponse(500, false, 'Server Error'));

      await expect(processor.process(job as any)).rejects.toThrow('HTTP 500');

      expect(db.update).toHaveBeenCalled();
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 2,
          status: 'pending', // still under max attempts
        }),
      );
    });

    it('should mark as failed when max attempts reached', async () => {
      const job = createJob();
      job.attemptsMade = 4; // 5th attempt (0-indexed, will be +1 = 5 >= 5)
      job.opts.attempts = 5;

      fetchSpy.mockResolvedValueOnce(mockFetchResponse(502, false, 'Bad Gateway'));

      await expect(processor.process(job as any)).rejects.toThrow('HTTP 502');

      expect(db.set).toHaveBeenCalledWith(
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

      expect(db.set).toHaveBeenCalledWith(
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
