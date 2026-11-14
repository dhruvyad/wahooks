import { Controller, Get, INestApplication, Param } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SkipThrottle, ThrottlerModule, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { CallerThrottlerGuard, NO_RATE_LIMIT, callerOf } from './caller-throttler.guard';

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return 'ok';
  }

  @Get('connections/:id/send')
  send(@Param('id') id: string) {
    return id;
  }
}

@SkipThrottle(NO_RATE_LIMIT)
@Controller()
class ProbeController {
  @Get('probe')
  probe() {
    return 'ok';
  }
}

describe('CallerThrottlerGuard', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 2 }] })],
      controllers: [PingController],
      providers: [{ provide: APP_GUARD, useClass: CallerThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const ping = (token?: string) => {
    const req = request(app.getHttpServer()).get('/ping');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('gives each bearer token its own bucket, even from the same IP', async () => {
    await ping('wh_customer_a').expect(200);
    await ping('wh_customer_a').expect(200);
    await ping('wh_customer_a').expect(429);

    await ping('wh_customer_b').expect(200);
    await ping('wh_customer_b').expect(200);
  });

  it('keeps unauthenticated requests separate from token buckets', async () => {
    await ping('wh_customer_a').expect(200);
    await ping('wh_customer_a').expect(200);
    await ping('wh_customer_a').expect(429);

    await ping().expect(200);
    await ping().expect(200);
    await ping().expect(429);
  });
});

describe('CallerThrottlerGuard: per connection, under a per-caller ceiling', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', ttl: 60000, limit: 2 },
            { name: 'caller', ttl: 60000, limit: 5, getTracker: callerOf },
          ],
        }),
      ],
      controllers: [PingController, ProbeController],
      providers: [{ provide: APP_GUARD, useClass: CallerThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const send = (connection: string) =>
    request(app.getHttpServer()).get(`/connections/${connection}/send`).set('Authorization', 'Bearer wh_platform');

  it("one busy connection doesn't use up the token's allowance for its other connections", async () => {
    await send('conn-1').expect(200);
    await send('conn-1').expect(200);
    await send('conn-1').expect(429);
    await send('conn-2').expect(200);
    await send('conn-2').expect(200);
  });

  it('caps a caller across all its connections', async () => {
    for (const c of ['a', 'b', 'c', 'd', 'e']) await send(c).expect(200);
    await send('f').expect(429);
  });

  it('never limits routes marked NO_RATE_LIMIT', async () => {
    for (let i = 0; i < 8; i++) await request(app.getHttpServer()).get('/probe').expect(200);
  });
});

// @nestjs/throttler 6.5.0's in-memory storage cancelled every caller's expiry timers when any one caller's block
// ended, so other callers' counts only grew. The kubelet's probe bucket crept past the limit, GET /api answered 429,
// and the API pod kept going unready (Nov 2026). Fixed in 6.7.1.
describe('rate-limit storage', () => {
  afterEach(() => jest.useRealTimers());

  it("one caller's block ending doesn't keep another caller's old requests counted", async () => {
    jest.useFakeTimers();
    const storage = new ThrottlerStorageService();
    const hit = (key: string) => storage.increment(key, 60_000, 2, 60_000, 'default');

    await hit('a');
    await hit('a');
    expect((await hit('a')).isBlocked).toBe(true);

    jest.advanceTimersByTime(30_000);
    await hit('b');
    await hit('b');

    jest.advanceTimersByTime(31_000);
    expect((await hit('a')).isBlocked).toBe(false); // a's block is over

    jest.advanceTimersByTime(30_000); // b's two requests are now more than a minute old
    const b = await hit('b');
    expect(b.isBlocked).toBe(false);
    expect(b.totalHits).toBe(1);

    storage.onApplicationShutdown();
  });
});
