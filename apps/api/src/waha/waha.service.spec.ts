import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WahaService } from './waha.service';

describe('WahaService', () => {
  let service: WahaService;
  let fetchSpy: jest.SpyInstance;

  const workerUrl = '10.0.0.1';
  const apiKey = 'test-api-key';

  function mockFetchResponse(body: any, status = 200, ok = true) {
    return {
      ok,
      status,
      text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WahaService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('50') } },
      ],
    }).compile();

    service = module.get<WahaService>(WahaService);

    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockFetchResponse({}),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('createSession', () => {
    it('should build correct URL, headers, and body', async () => {
      const responseData = { name: 'test-session', status: 'STARTING' };
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(responseData));

      const result = await service.createSession(workerUrl, apiKey, 'test-session', 'https://hooks.example.com/wh');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];

      expect(url).toBe('http://10.0.0.1:3000/api/sessions');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'X-Api-Key': 'test-api-key',
        'Content-Type': 'application/json',
      });

      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.name).toBe('test-session');
      expect(parsedBody.config.webhooks).toEqual([
        { url: 'https://hooks.example.com/wh', events: ['*'] },
      ]);

      expect(result).toEqual(responseData);
    });

    it('should send empty webhooks array when no webhookUrl provided', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ name: 'sess', status: 'STARTING' }));

      await service.createSession(workerUrl, apiKey, 'sess');

      const parsedBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(parsedBody.config.webhooks).toEqual([]);
    });

    it('should return parsed response', async () => {
      const responseData = { name: 'my-session', status: 'WORKING' as const };
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(responseData));

      const result = await service.createSession(workerUrl, apiKey, 'my-session');
      expect(result).toEqual(responseData);
    });
  });

  describe('startSession', () => {
    it('should use POST method and correct URL', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(''));

      await service.startSession(workerUrl, apiKey, 'my-session');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:3000/api/sessions/my-session/start');
      expect(options.method).toBe('POST');
      expect(options.headers['X-Api-Key']).toBe(apiKey);
    });

    it('should encode special characters in session name', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(''));

      await service.startSession(workerUrl, apiKey, 'session with spaces');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:3000/api/sessions/session%20with%20spaces/start');
    });
  });

  describe('stopSession', () => {
    it('should use POST method and correct URL', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse(''));

      await service.stopSession(workerUrl, apiKey, 'my-session');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:3000/api/sessions/my-session/stop');
      expect(options.method).toBe('POST');
    });
  });

  describe('getQrCode', () => {
    it('should use correct URL path and return base64-encoded image', async () => {
      const rawBytes = Buffer.from('fake-qr-image-data');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: jest.fn().mockResolvedValue(rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength)),
        headers: { get: jest.fn().mockReturnValue('image/png') },
      } as unknown as Response);

      const result = await service.getQrCode(workerUrl, apiKey, 'my-session');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://10.0.0.1:3000/api/my-session/auth/qr');
      expect(result.mimetype).toBe('image/png');
      expect(result.value).toBe(rawBytes.toString('base64'));
    });
  });

  describe('error handling', () => {
    it('should throw on HTTP errors with descriptive message', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse('Not Found', 404, false),
      );

      await expect(
        service.createSession(workerUrl, apiKey, 'fail-session'),
      ).rejects.toThrow('WAHA API error');
    });

    it('should throw on timeout (AbortError)', async () => {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      fetchSpy.mockRejectedValueOnce(abortError);

      await expect(
        service.createSession(workerUrl, apiKey, 'timeout-session'),
      ).rejects.toThrow('WAHA API timeout');
    });

    it('should re-throw unexpected errors', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network failure'));

      await expect(
        service.createSession(workerUrl, apiKey, 'err-session'),
      ).rejects.toThrow('Network failure');
    });
  });
});
