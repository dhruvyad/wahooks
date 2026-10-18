import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { CallerThrottlerGuard } from './caller-throttler.guard';

@Controller()
class PingController {
  @Get('ping')
  ping() {
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
