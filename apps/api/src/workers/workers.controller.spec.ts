import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import { WorkersController } from './workers.controller';
import { WorkersService } from './workers.service';
import { GatewayResourcesService } from './gateway-resources.service';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { EventMetricsService } from '../events/event-metrics.service';
import { FakeRedis, failingQueue, queueWith } from '../events/fake-redis.testing';

const NOW = Date.parse('2026-11-10T14:07:30.000Z');

describe('WorkersController (GET /infrastructure)', () => {
  let app: INestApplication;
  let redis: FakeRedis;
  let metrics: EventMetricsService;
  let db: any;
  let webhookQueue: { getJobCounts: jest.Mock };

  async function start(eventMetrics: EventMetricsService) {
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkersController],
      providers: [
        { provide: DRIZZLE_TOKEN, useValue: db },
        { provide: getQueueToken('webhook-delivery'), useValue: webhookQueue },
        { provide: WorkersService, useValue: { getScaleUpFailure: () => null } },
        { provide: GatewayResourcesService, useValue: { resourcesFor: async () => new Map() } },
        { provide: EventMetricsService, useValue: eventMetrics },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { sub: 'admin-1' };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis = new FakeRedis();
    metrics = new EventMetricsService(queueWith(redis));
    db = {};
    for (const m of ['select', 'from', 'where']) db[m] = jest.fn().mockReturnValue(db);
    db.where.mockResolvedValueOnce([]); // workers
    db.groupBy = jest.fn().mockResolvedValue([]); // session counts
    webhookQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 3, active: 1, delayed: 2, failed: 1000, completed: 100 }),
    };
    await metrics.countReceived('message', NOW - 120_000);
    await metrics.countReceived('session.status', NOW - 120_000);
    await metrics.countDelivery('delivered', NOW - 120_000);
    await metrics.countDelivery('failed', NOW - 60_000);
    await metrics.countDelivery('failed', NOW - 3 * 24 * 3600_000); // outside 24 h
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  describe('GET /infrastructure/events', () => {
    it('returns buckets, totals, the current rate and event types for the range', async () => {
      await start(metrics);
      const res = await request(app.getHttpServer()).get('/infrastructure/events?range=24h').expect(200);

      expect(Object.keys(res.body).sort()).toEqual([
        'available', 'bucketSeconds', 'buckets', 'byType', 'dataSince', 'from', 'range', 'ratePerMinute', 'to', 'totals',
      ]);
      expect(res.body).toMatchObject({
        range: '24h',
        bucketSeconds: 300,
        from: '2026-11-09T14:10:00.000Z',
        to: '2026-11-10T14:07:30.000Z',
        available: true,
        totals: { received: 2, messages: 1, delivered: 1, failed: 1, retried: 0 },
        ratePerMinute: 0.4,
        dataSince: '2026-11-10T14:05:00.000Z',
        byType: {
          since: '2026-11-09T14:00:00.000Z',
          types: [
            { type: 'message', count: 1 },
            { type: 'session.status', count: 1 },
          ],
        },
      });
      expect(res.body.buckets).toHaveLength(288);
      for (const bucket of res.body.buckets) {
        expect(Object.keys(bucket).sort()).toEqual(['delivered', 'failed', 'messages', 'received', 'retried', 't']);
      }
      expect(res.body.buckets[287]).toEqual({
        t: '2026-11-10T14:05:00.000Z', received: 2, messages: 1, delivered: 1, failed: 1, retried: 0,
      });
    });

    it('defaults to the last hour, by the minute', async () => {
      await start(metrics);
      const res = await request(app.getHttpServer()).get('/infrastructure/events').expect(200);
      expect(res.body).toMatchObject({ range: '1h', bucketSeconds: 60, from: '2026-11-10T13:08:00.000Z' });
      expect(res.body.buckets).toHaveLength(60);
    });

    it('7d: hourly buckets', async () => {
      await start(metrics);
      const res = await request(app.getHttpServer()).get('/infrastructure/events?range=7d').expect(200);
      expect(res.body).toMatchObject({ range: '7d', bucketSeconds: 3600 });
      expect(res.body.buckets).toHaveLength(168);
      expect(res.body.totals.failed).toBe(2);
    });

    it('refuses any other range', async () => {
      await start(metrics);
      const res = await request(app.getHttpServer()).get('/infrastructure/events?range=30d').expect(400);
      expect(res.body.message).toBe('range must be one of 1h, 24h, 7d');
    });

    it('says so, with a 200, when Redis is down', async () => {
      await start(new EventMetricsService(failingQueue(new Error('ECONNREFUSED'))));
      const res = await request(app.getHttpServer()).get('/infrastructure/events?range=1h').expect(200);
      expect(res.body).toMatchObject({ range: '1h', available: false, buckets: [], ratePerMinute: null });
    });
  });

  describe('GET /infrastructure webhookQueue', () => {
    it('gives the failed jobs kept with their cap, and the deliveries given up on in the last 24 h', async () => {
      await start(metrics);
      const res = await request(app.getHttpServer()).get('/infrastructure').expect(200);
      expect(res.body.webhookQueue).toEqual({
        waiting: 3,
        active: 1,
        delayed: 2,
        failed: 1000,
        completed: 100,
        reachable: true,
        failedKept: 1000,
        failedLast24h: 1,
      });
    });

    it('keeps the queue counts when the event counters are unreadable, and the reverse', async () => {
      await start(new EventMetricsService(failingQueue(new Error('ECONNREFUSED'))));
      let res = await request(app.getHttpServer()).get('/infrastructure').expect(200);
      expect(res.body.webhookQueue).toMatchObject({ failed: 1000, reachable: true, failedLast24h: null });
      await app.close();

      db.where.mockResolvedValueOnce([]);
      webhookQueue.getJobCounts.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await start(metrics);
      res = await request(app.getHttpServer()).get('/infrastructure').expect(200);
      expect(res.body.webhookQueue).toMatchObject({ failed: 0, reachable: false, failedLast24h: 1 });
    });
  });
});
