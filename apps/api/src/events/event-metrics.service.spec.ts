import { Logger } from '@nestjs/common';
import { EventMetricsService } from './event-metrics.service';
import { EVENT_METRICS_TTL_SECONDS } from './event-metrics';
import { FakeRedis, failingQueue, hangingQueue, queueWith } from './fake-redis.testing';

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-11-10T14:07:30.000Z');
const HOUR = 'wahooks:events:2026-11-10T14';

describe('EventMetricsService', () => {
  let redis: FakeRedis;
  let metrics: EventMetricsService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    redis = new FakeRedis();
    metrics = new EventMetricsService(queueWith(redis));
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const field = (key: string, f: string) => redis.hashes.get(key)?.get(f);

  describe('counting', () => {
    it('counts a message in its minute, its hour and its type, in one round trip', async () => {
      await metrics.countReceived('message', NOW);

      expect(redis.execs).toBe(1);
      expect(Object.fromEntries(redis.hashes.get(HOUR)!)).toEqual({
        '07:received': '1',
        received: '1',
        '07:messages': '1',
        messages: '1',
      });
      expect(Object.fromEntries(redis.hashes.get(`${HOUR}:types`)!)).toEqual({ message: '1' });
      expect(redis.ttls.get(HOUR)).toBe(EVENT_METRICS_TTL_SECONDS);
      expect(redis.ttls.get(`${HOUR}:types`)).toBe(EVENT_METRICS_TTL_SECONDS);
    });

    it('counts other events as received but not as messages', async () => {
      await metrics.countReceived('session.status', NOW);
      await metrics.countReceived('message.any', NOW);

      expect(field(HOUR, '07:received')).toBe('2');
      expect(field(HOUR, '07:messages')).toBeUndefined();
      expect(Object.fromEntries(redis.hashes.get(`${HOUR}:types`)!)).toEqual({
        'session.status': '1',
        'message.any': '1',
      });
    });

    it('folds a strange event name into one type field', async () => {
      await metrics.countReceived('{"$where":1}', NOW);
      expect(Object.fromEntries(redis.hashes.get(`${HOUR}:types`)!)).toEqual({ '(other)': '1' });
    });

    it('counts each delivery outcome in its minute and hour', async () => {
      await metrics.countDelivery('delivered', NOW);
      await metrics.countDelivery('delivered', T('2026-11-10T14:08:01Z'));
      await metrics.countDelivery('retried', NOW);
      await metrics.countDelivery('failed', NOW);

      expect(redis.execs).toBe(4);
      expect(Object.fromEntries(redis.hashes.get(HOUR)!)).toEqual({
        '07:delivered': '1',
        '08:delivered': '1',
        delivered: '2',
        '07:retried': '1',
        retried: '1',
        '07:failed': '1',
        failed: '1',
      });
      expect(redis.ttls.get(HOUR)).toBe(EVENT_METRICS_TTL_SECONDS);
      expect(redis.hashes.has(`${HOUR}:types`)).toBe(false);
    });

    it('rolls over to the next hour hash', async () => {
      await metrics.countReceived('message', T('2026-11-10T14:59:59.999Z'));
      await metrics.countReceived('message', T('2026-11-10T15:00:00.000Z'));

      expect(field(HOUR, '59:received')).toBe('1');
      expect(field('wahooks:events:2026-11-10T15', '00:received')).toBe('1');
    });
  });

  describe('when Redis fails', () => {
    it('never rejects, whether the connection, the pipeline or a command fails', async () => {
      const failing = [
        new EventMetricsService(failingQueue(new Error('ECONNREFUSED'))),
        new EventMetricsService(
          queueWith({ pipeline: () => ({ hincrby() { return this; }, expire() { return this; }, exec: () => Promise.reject(new Error('Connection is closed.')) }) }),
        ),
        new EventMetricsService(
          queueWith({ pipeline: () => ({ hincrby() { return this; }, expire() { return this; }, exec: async () => [[new Error('WRONGTYPE'), null]] }) }),
        ),
        new EventMetricsService(
          queueWith({ pipeline: () => { throw new Error('pipeline() blew up'); } }),
        ),
      ];
      for (const m of failing) {
        await expect(m.countReceived('message', NOW)).resolves.toBeUndefined();
        await expect(m.countDelivery('failed', NOW)).resolves.toBeUndefined();
      }
    });

    it('logs at most once a minute, with how many counts were lost', async () => {
      const m = new EventMetricsService(failingQueue(new Error('ECONNREFUSED')));
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T('2026-11-10T14:00:00Z'));

      await m.countReceived('message', NOW);
      await m.countReceived('message', NOW);
      clock.mockReturnValue(T('2026-11-10T14:00:59Z'));
      await m.countDelivery('delivered', NOW);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('ECONNREFUSED');

      clock.mockReturnValue(T('2026-11-10T14:01:00Z'));
      await m.countDelivery('failed', NOW);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toContain('3 since the last report');
    });

    it('drops counts instead of queueing without bound while Redis hangs', async () => {
      const m = new EventMetricsService(hangingQueue());
      for (let i = 0; i < 1_000; i++) void m.countReceived('message', NOW);

      // The 1001st returns at once instead of joining the queue.
      await expect(m.countReceived('message', NOW)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped one'));
    });
  });

  describe('reading', () => {
    async function seed() {
      // 13:30: 3 events, 2 of them messages, delivered.
      for (const type of ['message', 'message', 'session.status']) {
        await metrics.countReceived(type, T('2026-11-10T13:30:10Z'));
      }
      await metrics.countDelivery('delivered', T('2026-11-10T13:30:20Z'));
      await metrics.countDelivery('delivered', T('2026-11-10T13:30:21Z'));
      // 14:02-14:06 (the rate window): 10 events.
      for (let i = 0; i < 10; i++) {
        await metrics.countReceived('message.any', T(`2026-11-10T14:0${2 + (i % 5)}:00Z`));
      }
      // 14:07 (the current minute): a failure after a retry.
      await metrics.countDelivery('retried', NOW);
      await metrics.countDelivery('failed', NOW);
      // Four days ago.
      await metrics.countReceived('message', T('2026-11-06T09:15:00Z'));
      await metrics.countDelivery('failed', T('2026-11-06T09:15:00Z'));
      redis.commands.length = 0;
      redis.execs = 0;
    }

    it('1h: per-minute buckets from the two hour hashes, in one round trip', async () => {
      await seed();
      const volume = await metrics.read('1h', NOW);

      expect(redis.execs).toBe(1);
      expect(redis.named('hgetall').map(([, key]) => key)).toEqual([
        'wahooks:events:2026-11-10T13',
        'wahooks:events:2026-11-10T14',
        'wahooks:events:2026-11-10T13:types',
        'wahooks:events:2026-11-10T14:types',
      ]);
      expect(volume.available).toBe(true);
      expect(volume.buckets).toHaveLength(60);
      expect(volume.buckets.find((b) => b.t === '2026-11-10T13:30:00.000Z')).toEqual({
        t: '2026-11-10T13:30:00.000Z', received: 3, messages: 2, delivered: 2, failed: 0, retried: 0,
      });
      expect(volume.buckets[59]).toMatchObject({ t: '2026-11-10T14:07:00.000Z', failed: 1, retried: 1 });
      expect(volume.totals).toEqual({ received: 13, messages: 2, delivered: 2, failed: 1, retried: 1 });
      expect(volume.ratePerMinute).toBe(2);
      expect(volume.dataSince).toBe('2026-11-10T13:30:00.000Z');
      expect(volume.byType).toEqual({
        since: '2026-11-10T13:00:00.000Z',
        types: [
          { type: 'message.any', count: 10 },
          { type: 'message', count: 2 },
          { type: 'session.status', count: 1 },
        ],
      });
    });

    it('24h: five-minute buckets', async () => {
      await seed();
      const volume = await metrics.read('24h', NOW);

      expect(volume.buckets).toHaveLength(288);
      expect(volume.bucketSeconds).toBe(300);
      expect(volume.buckets[287]).toMatchObject({ t: '2026-11-10T14:05:00.000Z', received: 4, failed: 1 });
      expect(volume.buckets[286]).toMatchObject({ t: '2026-11-10T14:00:00.000Z', received: 6 });
      expect(volume.totals.received).toBe(13);
    });

    it('7d: hourly buckets from the rollup fields alone, so a week stays cheap to read', async () => {
      await seed();
      const volume = await metrics.read('7d', NOW);

      expect(redis.execs).toBe(1);
      // Hour hashes are read by their 5 rollup fields; only the small types hashes in full.
      expect(redis.named('hgetall').every(([, key]) => String(key).endsWith(':types'))).toBe(true);
      const rollups = redis.named('hmget').filter(([, , f]) => f === 'received');
      expect(rollups).toHaveLength(168);
      expect(volume.buckets).toHaveLength(168);
      expect(volume.buckets.find((b) => b.t === '2026-11-06T09:00:00.000Z')).toMatchObject({ received: 1, failed: 1 });
      expect(volume.buckets[167]).toMatchObject({ t: '2026-11-10T14:00:00.000Z', received: 10, failed: 1, retried: 1 });
      expect(volume.totals).toEqual({ received: 14, messages: 3, delivered: 2, failed: 2, retried: 1 });
      expect(volume.ratePerMinute).toBe(2);
      expect(volume.dataSince).toBe('2026-11-06T09:00:00.000Z');
    });

    it('an empty store reads as zeros, not as unavailable', async () => {
      const volume = await metrics.read('1h', NOW);
      expect(volume).toMatchObject({ available: true, ratePerMinute: 0, dataSince: null });
      expect(volume.totals.received).toBe(0);
    });

    it('reports unavailable when Redis fails', async () => {
      const m = new EventMetricsService(
        queueWith({ pipeline: () => ({ hgetall() { return this; }, hmget() { return this; }, exec: () => Promise.reject(new Error('Connection is closed.')) }) }),
      );
      const volume = await m.read('24h', NOW);
      expect(volume).toMatchObject({ range: '24h', available: false, buckets: [], ratePerMinute: null });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Connection is closed.'));
    });

    it('gives up after 3 s when Redis hangs', async () => {
      jest.useFakeTimers();
      try {
        const m = new EventMetricsService(hangingQueue());
        const reading = m.read('1h', NOW);
        await jest.advanceTimersByTimeAsync(3_000);
        await expect(reading).resolves.toMatchObject({ available: false });
      } finally {
        jest.useRealTimers();
      }
    });

    it('countRecent sums a counter over a rolling window', async () => {
      await seed();
      // The last 24 h: today's failure; the one 4 days ago is outside.
      await expect(metrics.countRecent('failed', 24 * 60, NOW)).resolves.toBe(1);
      expect(redis.named('hmget')).toHaveLength(25);
      await expect(metrics.countRecent('failed', 7 * 24 * 60, NOW)).resolves.toBe(2);
      await expect(metrics.countRecent('received', 1, NOW)).resolves.toBe(0);
    });

    it('countRecent is null when Redis fails', async () => {
      const m = new EventMetricsService(failingQueue(new Error('ECONNREFUSED')));
      await expect(m.countRecent('failed', 24 * 60, NOW)).resolves.toBeNull();
    });
  });
});
