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

    it('maps WAHA 5xx to HttpException 502 with the concise upstream detail', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse(
          { statusCode: 500, exception: { message: 'Invalid URL', stack: 'AxiosError: ...' } },
          500,
          false,
        ),
      );

      const err = await service
        .createSession(workerUrl, apiKey, 'fail-session')
        .catch((e) => e);
      expect(err.getStatus()).toBe(502);
      expect(err.message).toContain('WAHA API error');
      expect(err.message).toContain('Invalid URL');
      expect(err.message).not.toContain('AxiosError'); // stack traces stripped
    });

    it('maps WAHA 4xx to HttpException 400', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ message: 'chatId is invalid' }, 422, false),
      );

      const err = await service
        .createSession(workerUrl, apiKey, 'fail-session')
        .catch((e) => e);
      expect(err.getStatus()).toBe(400);
      expect(err.message).toContain('chatId is invalid');
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

  describe('resolveChatId', () => {
    const sess = 'u_x_s_y';

    it('normalizes a phone target via check-exists (fixes BR 9th-digit / @s.whatsapp.net)', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ numberExists: true, chatId: '553197471917@c.us' }),
      );

      const out = await service.resolveChatId(
        workerUrl, apiKey, sess, '5531997471917@s.whatsapp.net',
      );

      expect(out).toBe('553197471917@c.us');
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/contacts/check-exists');
      expect(url).toContain('phone=5531997471917');
    });

    it('leaves @lid and @g.us targets untouched (no lookup)', async () => {
      expect(
        await service.resolveChatId(workerUrl, apiKey, sess, '171051518537926@lid'),
      ).toBe('171051518537926@lid');
      expect(
        await service.resolveChatId(workerUrl, apiKey, sess, '120363@g.us'),
      ).toBe('120363@g.us');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns the original chatId when the number is not on WhatsApp', async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ numberExists: false }));
      const out = await service.resolveChatId(
        workerUrl, apiKey, sess, '5531900000000@c.us',
      );
      expect(out).toBe('5531900000000@c.us');
    });

    it('never throws — falls back to the original chatId on a WAHA error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('boom'));
      const out = await service.resolveChatId(workerUrl, apiKey, sess, '5531997471917');
      expect(out).toBe('5531997471917');
    });

    it('caches the resolution (second call does not hit WAHA)', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ numberExists: true, chatId: '553197471917@c.us' }),
      );
      const first = await service.resolveChatId(workerUrl, apiKey, sess, '5531997471917');
      const second = await service.resolveChatId(workerUrl, apiKey, sess, '5531997471917');
      expect(first).toBe('553197471917@c.us');
      expect(second).toBe('553197471917@c.us');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('decodes a percent-encoded data: URL into base64 file data (sendFile)', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ numberExists: true, chatId: '201025211306@c.us' }),
        ) // resolveChatId
        .mockResolvedValueOnce(mockFetchResponse({ key: { id: 'm1' } })); // sendFile

      await service.sendFile(
        workerUrl, apiKey, 'u_x_s_y', '201025211306@c.us',
        dataUrl, 'report.svg', undefined, undefined, undefined,
        { skipPresence: true },
      );

      const body = JSON.parse((fetchSpy.mock.calls[1][1] as any).body);
      expect(body.file.url).toBeUndefined();
      expect(body.file.mimetype).toBe('image/svg+xml');
      expect(body.file.filename).toBe('report.svg');
      expect(Buffer.from(body.file.data, 'base64').toString('utf8')).toBe(svg);
    });

    it('decodes a base64 data: URL into file data (sendImage)', async () => {
      const png = Buffer.from('fake-png-bytes').toString('base64');
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ numberExists: true, chatId: '201025211306@c.us' }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ key: { id: 'm2' } }));

      await service.sendImage(
        workerUrl, apiKey, 'u_x_s_y', '201025211306@c.us',
        `data:image/png;base64,${png}`, undefined, undefined, undefined,
        { skipPresence: true },
      );

      const body = JSON.parse((fetchSpy.mock.calls[1][1] as any).body);
      expect(body.file.url).toBeUndefined();
      expect(body.file.mimetype).toBe('image/png');
      expect(body.file.data).toBe(png);
    });

    it('sendText sends to the resolved chatId, not the raw one', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockFetchResponse({ numberExists: true, chatId: '553197471917@c.us' }),
        ) // check-exists
        .mockResolvedValueOnce(mockFetchResponse({ key: { id: 'm1' } })); // sendText

      await service.sendText(
        workerUrl, apiKey, sess, '5531997471917@s.whatsapp.net', 'hi',
        { skipPresence: true },
      );

      const body = JSON.parse((fetchSpy.mock.calls[1][1] as any).body);
      expect(body.chatId).toBe('553197471917@c.us');
      expect(body.text).toBe('hi');
    });
  });
});
