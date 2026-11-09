/**
 * Event volume counters kept in Redis, and the bucket maths that reads them back
 * for GET /api/infrastructure/events.
 *
 * Key scheme: one hash per UTC hour, `wahooks:events:<YYYY-MM-DDTHH>`, expiring
 * 8 days after its last write, with
 *   `<mm>:<counter>`  the count in minute mm (00-59) of that hour, and
 *   `<counter>`       the count for the whole hour (what the 7-day range reads),
 * plus `wahooks:events:<YYYY-MM-DDTHH>:types`, the hour's received events by
 * event type.
 *
 * Counters:
 *   received   events accepted at POST /api/events/waha for a known connection
 *   messages   the `message` events among them (incoming WhatsApp messages)
 *   delivered  webhook deliveries that succeeded
 *   failed     deliveries whose final attempt failed (given up)
 *   retried    failed attempts that BullMQ will retry
 * Every delivery attempt adds to exactly one of delivered / failed / retried.
 */

export const EVENT_COUNTERS = ['received', 'messages', 'delivered', 'failed', 'retried'] as const;
export type EventCounter = (typeof EVENT_COUNTERS)[number];
export type EventCounts = Record<EventCounter, number>;
export type DeliveryOutcome = 'delivered' | 'failed' | 'retried';

/** Long enough for the 7-day range, with a day to spare. */
export const EVENT_METRICS_TTL_SECONDS = 8 * 24 * 60 * 60;
/** The current rate averages this many complete minutes. */
export const RATE_WINDOW_MINUTES = 5;

const MINUTE_MS = 60_000;
const KEY_PREFIX = 'wahooks:events:';
/** Event names WAHA and the gateways send (`message`, `session.status`, ...). Anything else is counted as OTHER_TYPE. */
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OTHER_TYPE = '(other)';

export const EVENT_RANGES = {
  '1h': { bucketMinutes: 1, bucketCount: 60 },
  '24h': { bucketMinutes: 5, bucketCount: 288 },
  '7d': { bucketMinutes: 60, bucketCount: 168 },
} as const;
export type EventRange = keyof typeof EVENT_RANGES;

export function isEventRange(value: unknown): value is EventRange {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_RANGES, value);
}

export function zeroCounts(): EventCounts {
  return { received: 0, messages: 0, delivered: 0, failed: 0, retried: 0 };
}

/** The hash for Unix hour `hour` (hours since the epoch, UTC). */
export function hourKey(hour: number): string {
  return `${KEY_PREFIX}${new Date(hour * 60 * MINUTE_MS).toISOString().slice(0, 13)}`;
}

export function typesKey(hour: number): string {
  return `${hourKey(hour)}:types`;
}

/** The field of Unix minute `minute` in its hour's hash, e.g. `07:received`. */
export function minuteField(minute: number, counter: EventCounter): string {
  return `${String(minute % 60).padStart(2, '0')}:${counter}`;
}

/** The type hash field for an event name; names that don't look like one share OTHER_TYPE, so callers can't grow the hash. */
export function typeField(eventType: unknown): string {
  return typeof eventType === 'string' && EVENT_TYPE_PATTERN.test(eventType) ? eventType : OTHER_TYPE;
}

export function unixMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}

export interface RangePlan {
  range: EventRange;
  bucketMinutes: number;
  bucketCount: number;
  /** Unix minute the first bucket starts at. */
  firstMinute: number;
  /** The current minute: the last one counted, still filling. */
  nowMinute: number;
  /** Unix hours whose hashes cover the range, oldest first. */
  hours: number[];
}

/**
 * Buckets for a range ending now: aligned to whole bucket widths in UTC, the last
 * one the bucket that holds the current minute (still filling). 1h is 60 one-minute
 * buckets, 24h 288 five-minute buckets, 7d 168 one-hour buckets.
 */
export function planRange(range: EventRange, nowMs: number): RangePlan {
  const { bucketMinutes, bucketCount } = EVENT_RANGES[range];
  const nowMinute = unixMinute(nowMs);
  const lastBucketStart = nowMinute - (nowMinute % bucketMinutes);
  const firstMinute = lastBucketStart - (bucketCount - 1) * bucketMinutes;
  const hours: number[] = [];
  for (let h = Math.floor(firstMinute / 60); h <= Math.floor(nowMinute / 60); h++) hours.push(h);
  return { range, bucketMinutes, bucketCount, firstMinute, nowMinute, hours };
}

/** The complete minutes the current rate averages: the RATE_WINDOW_MINUTES before the current one. */
export function rateMinutes(nowMinute: number): number[] {
  const minutes: number[] = [];
  for (let m = nowMinute - RATE_WINDOW_MINUTES; m < nowMinute; m++) minutes.push(m);
  return minutes;
}

/** Counts by Unix minute; an hourly rollup is keyed by its hour's first minute. */
export type CountsByMinute = Map<number, Partial<EventCounts>>;

function addCount(into: CountsByMinute, minute: number, counter: EventCounter, value: number) {
  if (!Number.isFinite(value) || value <= 0) return;
  const entry = into.get(minute) ?? {};
  entry[counter] = (entry[counter] ?? 0) + value;
  into.set(minute, entry);
}

const COUNTER_SET = new Set<string>(EVENT_COUNTERS);

/** Reads the per-minute fields of an hour hash (HGETALL) into `into`; the hourly rollups are skipped. */
export function addMinuteFields(
  into: CountsByMinute,
  hour: number,
  hash: Record<string, string> | null | undefined,
): void {
  for (const [field, raw] of Object.entries(hash ?? {})) {
    const match = /^(\d{2}):([a-z]+)$/.exec(field);
    if (!match || !COUNTER_SET.has(match[2])) continue;
    const mm = Number(match[1]);
    if (mm > 59) continue;
    addCount(into, hour * 60 + mm, match[2] as EventCounter, Number(raw));
  }
}

/** Reads an hour's rollup fields (HMGET of EVENT_COUNTERS, in order) into `into`. */
export function addHourRollup(
  into: CountsByMinute,
  hour: number,
  values: Array<string | null> | null | undefined,
): void {
  EVENT_COUNTERS.forEach((counter, i) => addCount(into, hour * 60, counter, Number(values?.[i] ?? 0)));
}

export interface EventBucket extends EventCounts {
  /** Start of the bucket, ISO 8601. */
  t: string;
}

export interface EventVolume {
  range: EventRange;
  bucketSeconds: number;
  /** Start of the first bucket. */
  from: string;
  /** When this was read; the last bucket is still filling. */
  to: string;
  /** False when Redis couldn't be read: buckets are then empty and the totals zero. */
  available: boolean;
  buckets: EventBucket[];
  totals: EventCounts;
  /** Events received per minute, averaged over the last RATE_WINDOW_MINUTES complete minutes. */
  ratePerMinute: number | null;
  /** Start of the earliest bucket with any count in it; null when nothing was counted in the range. */
  dataSince: string | null;
  /** Received events by type, most first. Kept per hour, so counted from the start of the range's first hour (`since`). */
  byType: { since: string; types: Array<{ type: string; count: number }> };
}

/** Sums counts into the plan's buckets; counts outside the range are ignored. */
export function toBuckets(plan: RangePlan, counts: CountsByMinute): EventBucket[] {
  const buckets: EventBucket[] = [];
  for (let i = 0; i < plan.bucketCount; i++) {
    const start = plan.firstMinute + i * plan.bucketMinutes;
    buckets.push({ t: new Date(start * MINUTE_MS).toISOString(), ...zeroCounts() });
  }
  for (const [minute, entry] of counts) {
    if (minute < plan.firstMinute || minute > plan.nowMinute) continue;
    const bucket = buckets[Math.floor((minute - plan.firstMinute) / plan.bucketMinutes)];
    if (!bucket) continue;
    for (const counter of EVENT_COUNTERS) bucket[counter] += entry[counter] ?? 0;
  }
  return buckets;
}

export function buildVolume(
  plan: RangePlan,
  nowMs: number,
  counts: CountsByMinute,
  rateReceived: number,
  types: Map<string, number>,
): EventVolume {
  const buckets = toBuckets(plan, counts);
  const totals = zeroCounts();
  let dataSince: string | null = null;
  for (const bucket of buckets) {
    let any = false;
    for (const counter of EVENT_COUNTERS) {
      totals[counter] += bucket[counter];
      if (bucket[counter] > 0) any = true;
    }
    if (any && dataSince === null) dataSince = bucket.t;
  }
  return {
    ...rangeFrame(plan, nowMs),
    available: true,
    buckets,
    totals,
    ratePerMinute: Math.round((rateReceived / RATE_WINDOW_MINUTES) * 10) / 10,
    dataSince,
    byType: {
      since: new Date(plan.hours[0] * 60 * MINUTE_MS).toISOString(),
      types: [...types.entries()]
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([type, count]) => ({ type, count })),
    },
  };
}

/** The response when the counters couldn't be read. */
export function unavailableVolume(plan: RangePlan, nowMs: number): EventVolume {
  return {
    ...rangeFrame(plan, nowMs),
    available: false,
    buckets: [],
    totals: zeroCounts(),
    ratePerMinute: null,
    dataSince: null,
    byType: { since: new Date(plan.hours[0] * 60 * MINUTE_MS).toISOString(), types: [] },
  };
}

function rangeFrame(plan: RangePlan, nowMs: number) {
  return {
    range: plan.range,
    bucketSeconds: plan.bucketMinutes * 60,
    from: new Date(plan.firstMinute * MINUTE_MS).toISOString(),
    to: new Date(nowMs).toISOString(),
  };
}
