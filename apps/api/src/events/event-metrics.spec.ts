import {
  CountsByMinute,
  EVENT_METRICS_TTL_SECONDS,
  OTHER_TYPE,
  addHourRollup,
  addMinuteFields,
  buildVolume,
  hourKey,
  isEventRange,
  minuteField,
  planRange,
  rateMinutes,
  toBuckets,
  typeField,
  typesKey,
  unavailableVolume,
  unixMinute,
} from './event-metrics';

const NOW = Date.parse('2026-11-10T14:07:30.000Z');
const at = (iso: string) => unixMinute(Date.parse(iso));
const iso = (minute: number) => new Date(minute * 60_000).toISOString();
const hourOf = (isoHour: string) => Math.floor(Date.parse(isoHour) / 3_600_000);

describe('event metrics keys', () => {
  it('keeps one hash per UTC hour, readable in redis-cli, with a types hash beside it', () => {
    const hour = hourOf('2026-11-10T14:00:00Z');
    expect(hourKey(hour)).toBe('wahooks:events:2026-11-10T14');
    expect(typesKey(hour)).toBe('wahooks:events:2026-11-10T14:types');
  });

  it("names a minute's field by its two-digit minute in the hour", () => {
    expect(minuteField(at('2026-11-10T14:07:00Z'), 'received')).toBe('07:received');
    expect(minuteField(at('2026-11-10T14:59:00Z'), 'failed')).toBe('59:failed');
    expect(minuteField(at('2026-11-10T15:00:00Z'), 'messages')).toBe('00:messages');
  });

  it('keeps event names that look like one, and folds anything else into one field', () => {
    expect(typeField('message')).toBe('message');
    expect(typeField('session.status')).toBe('session.status');
    expect(typeField('group.v2.participants')).toBe('group.v2.participants');
    expect(typeField('')).toBe(OTHER_TYPE);
    expect(typeField('x'.repeat(65))).toBe(OTHER_TYPE);
    expect(typeField('message\nINJECTED')).toBe(OTHER_TYPE);
    expect(typeField(undefined)).toBe(OTHER_TYPE);
    expect(typeField(42)).toBe(OTHER_TYPE);
  });

  it('expires keys after 8 days, past the longest range', () => {
    expect(EVENT_METRICS_TTL_SECONDS).toBe(8 * 24 * 3600);
  });

  it('knows the three ranges', () => {
    expect(['1h', '24h', '7d'].every(isEventRange)).toBe(true);
    expect(isEventRange('30d')).toBe(false);
    expect(isEventRange('toString')).toBe(false);
    expect(isEventRange(undefined)).toBe(false);
  });
});

describe('planRange', () => {
  it('1h: 60 one-minute buckets ending with the current minute', () => {
    const plan = planRange('1h', NOW);
    expect(plan.bucketMinutes).toBe(1);
    expect(plan.bucketCount).toBe(60);
    expect(iso(plan.firstMinute)).toBe('2026-11-10T13:08:00.000Z');
    expect(iso(plan.nowMinute)).toBe('2026-11-10T14:07:00.000Z');
    expect(plan.hours.map((h) => hourKey(h))).toEqual([
      'wahooks:events:2026-11-10T13',
      'wahooks:events:2026-11-10T14',
    ]);
  });

  it('1h at minute 59 reads a single hour', () => {
    const plan = planRange('1h', Date.parse('2026-11-10T14:59:59.999Z'));
    expect(iso(plan.firstMinute)).toBe('2026-11-10T14:00:00.000Z');
    expect(plan.hours).toEqual([hourOf('2026-11-10T14:00:00Z')]);
  });

  it('24h: 288 five-minute buckets aligned to :00, :05, ... with the current one last', () => {
    const plan = planRange('24h', NOW);
    expect(plan.bucketMinutes).toBe(5);
    expect(plan.bucketCount).toBe(288);
    expect(iso(plan.firstMinute)).toBe('2026-11-09T14:10:00.000Z');
    // last bucket starts at 14:05 and holds 14:07
    expect(iso(plan.firstMinute + 287 * 5)).toBe('2026-11-10T14:05:00.000Z');
    expect(plan.hours).toHaveLength(25);
    expect(hourKey(plan.hours[0])).toBe('wahooks:events:2026-11-09T14');
    expect(hourKey(plan.hours[24])).toBe('wahooks:events:2026-11-10T14');
  });

  it('7d: 168 hourly buckets, one per hour hash', () => {
    const plan = planRange('7d', NOW);
    expect(plan.bucketMinutes).toBe(60);
    expect(plan.bucketCount).toBe(168);
    expect(iso(plan.firstMinute)).toBe('2026-11-03T15:00:00.000Z');
    expect(plan.hours).toHaveLength(168);
    expect(hourKey(plan.hours[0])).toBe('wahooks:events:2026-11-03T15');
    expect(hourKey(plan.hours[167])).toBe('wahooks:events:2026-11-10T14');
  });
});

describe('rateMinutes', () => {
  it('is the five complete minutes before the current one', () => {
    expect(rateMinutes(at('2026-11-10T14:02:00Z')).map(iso)).toEqual([
      '2026-11-10T13:57:00.000Z',
      '2026-11-10T13:58:00.000Z',
      '2026-11-10T13:59:00.000Z',
      '2026-11-10T14:00:00.000Z',
      '2026-11-10T14:01:00.000Z',
    ]);
  });
});

describe('reading hashes', () => {
  it('takes per-minute fields from an hour hash and skips rollups and junk', () => {
    const hour = hourOf('2026-11-10T14:00:00Z');
    const counts: CountsByMinute = new Map();
    addMinuteFields(counts, hour, {
      '07:received': '12',
      '07:messages': '5',
      '08:delivered': '3',
      received: '15', // the hour's rollup
      '61:received': '9', // no such minute
      '07:bogus': '1',
      '09:failed': 'NaN',
    });
    expect([...counts.entries()]).toEqual([
      [at('2026-11-10T14:07:00Z'), { received: 12, messages: 5 }],
      [at('2026-11-10T14:08:00Z'), { delivered: 3 }],
    ]);
  });

  it('takes an hour rollup (HMGET of the counters) as the hour first minute', () => {
    const hour = hourOf('2026-11-10T14:00:00Z');
    const counts: CountsByMinute = new Map();
    addHourRollup(counts, hour, ['100', '40', null, '2', '7']);
    expect(counts.get(hour * 60)).toEqual({ received: 100, messages: 40, failed: 2, retried: 7 });
  });
});

describe('toBuckets', () => {
  it('1h: one bucket per minute; counts outside the range are dropped', () => {
    const plan = planRange('1h', NOW);
    const counts: CountsByMinute = new Map([
      [at('2026-11-10T13:07:00Z'), { received: 99 }], // a minute before the range
      [at('2026-11-10T13:08:00Z'), { received: 1, messages: 1 }], // first bucket
      [at('2026-11-10T14:07:00Z'), { received: 4, delivered: 2 }], // current minute, last bucket
      [at('2026-11-10T14:08:00Z'), { received: 50 }], // the future
    ]);
    const buckets = toBuckets(plan, counts);
    expect(buckets).toHaveLength(60);
    expect(buckets[0]).toEqual({
      t: '2026-11-10T13:08:00.000Z', received: 1, messages: 1, delivered: 0, failed: 0, retried: 0,
    });
    expect(buckets[59]).toEqual({
      t: '2026-11-10T14:07:00.000Z', received: 4, messages: 0, delivered: 2, failed: 0, retried: 0,
    });
    expect(buckets.reduce((s, b) => s + b.received, 0)).toBe(5);
  });

  it('24h: sums the five minutes of each bucket', () => {
    const plan = planRange('24h', NOW);
    const counts: CountsByMinute = new Map([
      [at('2026-11-10T14:04:00Z'), { failed: 1 }],
      [at('2026-11-10T14:05:00Z'), { failed: 2 }],
      [at('2026-11-10T14:07:00Z'), { failed: 3 }],
      [at('2026-11-09T14:10:00Z'), { retried: 1 }],
      [at('2026-11-09T14:09:00Z'), { retried: 5 }], // before the first bucket
    ]);
    const buckets = toBuckets(plan, counts);
    expect(buckets).toHaveLength(288);
    expect(buckets[287]).toMatchObject({ t: '2026-11-10T14:05:00.000Z', failed: 5 });
    expect(buckets[286]).toMatchObject({ t: '2026-11-10T14:00:00.000Z', failed: 1 });
    expect(buckets[0]).toMatchObject({ t: '2026-11-09T14:10:00.000Z', retried: 1 });
    expect(buckets.reduce((s, b) => s + b.retried, 0)).toBe(1);
  });

  it('7d: an hourly rollup lands in its hour bucket', () => {
    const plan = planRange('7d', NOW);
    const counts: CountsByMinute = new Map();
    addHourRollup(counts, hourOf('2026-11-10T14:00:00Z'), ['10', '4', '8', '1', '2']);
    addHourRollup(counts, hourOf('2026-11-03T15:00:00Z'), ['7', '0', '7', '0', '0']);
    addHourRollup(counts, hourOf('2026-11-03T14:00:00Z'), ['500', '0', '0', '0', '0']); // 169 hours ago
    const buckets = toBuckets(plan, counts);
    expect(buckets).toHaveLength(168);
    expect(buckets[167]).toEqual({
      t: '2026-11-10T14:00:00.000Z', received: 10, messages: 4, delivered: 8, failed: 1, retried: 2,
    });
    expect(buckets[0]).toMatchObject({ t: '2026-11-03T15:00:00.000Z', received: 7, delivered: 7 });
    expect(buckets.reduce((s, b) => s + b.received, 0)).toBe(17);
  });
});

describe('buildVolume', () => {
  it('adds totals, the rate, where the data starts, and the event types most first', () => {
    const plan = planRange('1h', NOW);
    const counts: CountsByMinute = new Map([
      [at('2026-11-10T13:30:00Z'), { received: 3, messages: 2, delivered: 2 }],
      [at('2026-11-10T14:06:00Z'), { received: 7, delivered: 6, failed: 1, retried: 2 }],
    ]);
    const types = new Map([
      ['session.status', 3],
      ['message', 6],
      ['message.any', 6],
      ['presence.update', 0],
    ]);
    const volume = buildVolume(plan, NOW, counts, 12, types);
    expect(volume).toMatchObject({
      range: '1h',
      bucketSeconds: 60,
      from: '2026-11-10T13:08:00.000Z',
      to: '2026-11-10T14:07:30.000Z',
      available: true,
      totals: { received: 10, messages: 2, delivered: 8, failed: 1, retried: 2 },
      ratePerMinute: 2.4,
      dataSince: '2026-11-10T13:30:00.000Z',
      byType: {
        since: '2026-11-10T13:00:00.000Z',
        types: [
          { type: 'message', count: 6 },
          { type: 'message.any', count: 6 },
          { type: 'session.status', count: 3 },
        ],
      },
    });
    expect(volume.buckets).toHaveLength(60);
  });

  it('has no dataSince while nothing has been counted', () => {
    const volume = buildVolume(planRange('24h', NOW), NOW, new Map(), 0, new Map());
    expect(volume.dataSince).toBeNull();
    expect(volume.ratePerMinute).toBe(0);
    expect(volume.buckets).toHaveLength(288);
    expect(volume.buckets.every((b) => b.received === 0)).toBe(true);
  });

  it('reports an unreadable range with no buckets and no rate', () => {
    expect(unavailableVolume(planRange('7d', NOW), NOW)).toEqual({
      range: '7d',
      bucketSeconds: 3600,
      from: '2026-11-03T15:00:00.000Z',
      to: '2026-11-10T14:07:30.000Z',
      available: false,
      buckets: [],
      totals: { received: 0, messages: 0, delivered: 0, failed: 0, retried: 0 },
      ratePerMinute: null,
      dataSince: null,
      byType: { since: '2026-11-03T15:00:00.000Z', types: [] },
    });
  });
});
