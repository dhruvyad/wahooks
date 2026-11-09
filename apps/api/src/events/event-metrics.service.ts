import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CountsByMinute,
  DeliveryOutcome,
  EVENT_COUNTERS,
  EVENT_METRICS_TTL_SECONDS,
  EventCounter,
  EventRange,
  EventVolume,
  addHourRollup,
  addMinuteFields,
  buildVolume,
  hourKey,
  minuteField,
  planRange,
  rateMinutes,
  typeField,
  typesKey,
  unavailableVolume,
  unixMinute,
} from './event-metrics';

type RedisClient = Awaited<Queue['client']>;
type Pipeline = ReturnType<RedisClient['pipeline']>;

/** Counter writes waiting on Redis past this are dropped (Redis is slow or down), so they can't pile up in memory. */
const MAX_PENDING_WRITES = 1_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 3_000;

/**
 * Counts events and webhook deliveries per minute in Redis (key scheme in
 * ./event-metrics.ts) and reads them back as time series. It borrows the
 * `webhook-delivery` queue's Redis connection, so it adds none of its own.
 *
 * A count costs one pipelined round trip and is fire-and-forget: the count*
 * methods never reject, and a failure is logged at most once a minute. Reads
 * time out after 3 s and then report `available: false`.
 */
@Injectable()
export class EventMetricsService {
  private readonly logger = new Logger(EventMetricsService.name);
  private pendingWrites = 0;
  private failuresSinceLog = 0;
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;

  constructor(@InjectQueue('webhook-delivery') private readonly queue: Queue) {}

  /** Counts one event accepted at POST /api/events/waha. Never rejects. */
  countReceived(eventType: string, now = Date.now()): Promise<void> {
    return this.write(now, (pipeline, hour, minute) => {
      const key = hourKey(hour);
      pipeline.hincrby(key, minuteField(minute, 'received'), 1).hincrby(key, 'received', 1);
      if (eventType === 'message') {
        pipeline.hincrby(key, minuteField(minute, 'messages'), 1).hincrby(key, 'messages', 1);
      }
      pipeline
        .hincrby(typesKey(hour), typeField(eventType), 1)
        .expire(key, EVENT_METRICS_TTL_SECONDS)
        .expire(typesKey(hour), EVENT_METRICS_TTL_SECONDS);
    });
  }

  /** Counts the outcome of one delivery attempt. Never rejects. */
  countDelivery(outcome: DeliveryOutcome, now = Date.now()): Promise<void> {
    return this.write(now, (pipeline, hour, minute) => {
      const key = hourKey(hour);
      pipeline
        .hincrby(key, minuteField(minute, outcome), 1)
        .hincrby(key, outcome, 1)
        .expire(key, EVENT_METRICS_TTL_SECONDS);
    });
  }

  /** The range's buckets, totals, current rate and event types; `available: false` when Redis can't be read. */
  async read(range: EventRange, now = Date.now()): Promise<EventVolume> {
    const plan = planRange(range, now);
    const hourly = plan.bucketMinutes >= 60;
    const rateByHour = groupByHour(rateMinutes(plan.nowMinute));
    try {
      const results = await this.exec((pipeline) => {
        for (const hour of plan.hours) {
          if (hourly) pipeline.hmget(hourKey(hour), ...EVENT_COUNTERS);
          else pipeline.hgetall(hourKey(hour));
        }
        for (const hour of plan.hours) pipeline.hgetall(typesKey(hour));
        for (const [hour, minutes] of rateByHour) {
          pipeline.hmget(hourKey(hour), ...minutes.map((m) => minuteField(m, 'received')));
        }
      });

      let i = 0;
      const counts: CountsByMinute = new Map();
      for (const hour of plan.hours) {
        const value = results[i++];
        if (hourly) addHourRollup(counts, hour, value as Array<string | null>);
        else addMinuteFields(counts, hour, value as Record<string, string>);
      }
      const types = new Map<string, number>();
      for (let h = 0; h < plan.hours.length; h++) {
        for (const [type, raw] of Object.entries((results[i++] as Record<string, string>) ?? {})) {
          const n = Number(raw);
          if (Number.isFinite(n)) types.set(type, (types.get(type) ?? 0) + n);
        }
      }
      let rateReceived = 0;
      for (let h = 0; h < rateByHour.size; h++) {
        for (const raw of (results[i++] as Array<string | null>) ?? []) rateReceived += Number(raw ?? 0) || 0;
      }
      return buildVolume(plan, now, counts, rateReceived, types);
    } catch (err) {
      this.logger.warn(`Couldn't read event counts (${range}): ${message(err)}`);
      return unavailableVolume(plan, now);
    }
  }

  /** A counter's total over the last `minutes` minutes (the current one included); null when Redis can't be read. */
  async countRecent(counter: EventCounter, minutes: number, now = Date.now()): Promise<number | null> {
    const nowMinute = unixMinute(now);
    const window: number[] = [];
    for (let m = nowMinute - minutes + 1; m <= nowMinute; m++) window.push(m);
    const byHour = groupByHour(window);
    try {
      const results = await this.exec((pipeline) => {
        for (const [hour, ms] of byHour) pipeline.hmget(hourKey(hour), ...ms.map((m) => minuteField(m, counter)));
      });
      let total = 0;
      for (const values of results as Array<Array<string | null>>) {
        for (const raw of values ?? []) total += Number(raw ?? 0) || 0;
      }
      return total;
    } catch (err) {
      this.logger.warn(`Couldn't read the ${counter} count: ${message(err)}`);
      return null;
    }
  }

  private async write(
    now: number,
    build: (pipeline: Pipeline, hour: number, minute: number) => void,
  ): Promise<void> {
    if (this.pendingWrites >= MAX_PENDING_WRITES) {
      this.noteFailure(new Error(`${MAX_PENDING_WRITES} counter writes already waiting on Redis; dropped one`));
      return;
    }
    this.pendingWrites++;
    try {
      const client = await this.queue.client;
      const pipeline = client.pipeline();
      const minute = unixMinute(now);
      build(pipeline, Math.floor(minute / 60), minute);
      throwFirstError(await pipeline.exec());
    } catch (err) {
      this.noteFailure(err);
    } finally {
      this.pendingWrites--;
    }
  }

  /** Runs a read pipeline; rejects on a timeout or on any command's error. */
  private async exec(build: (pipeline: Pipeline) => void): Promise<unknown[]> {
    const client = await withTimeout(this.queue.client, READ_TIMEOUT_MS);
    const pipeline = client.pipeline();
    build(pipeline);
    const results = await withTimeout(pipeline.exec(), READ_TIMEOUT_MS);
    throwFirstError(results);
    return (results ?? []).map(([, value]) => value);
  }

  private noteFailure(err: unknown): void {
    this.failuresSinceLog++;
    const now = Date.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
    this.logger.warn(
      `Event counter write failed (${this.failuresSinceLog} since the last report; counts are being lost): ${message(err)}`,
    );
    this.failuresSinceLog = 0;
    this.lastFailureLogAt = now;
  }
}

function groupByHour(minutes: number[]): Map<number, number[]> {
  const byHour = new Map<number, number[]>();
  for (const m of minutes) {
    const hour = Math.floor(m / 60);
    byHour.set(hour, [...(byHour.get(hour) ?? []), m]);
  }
  return byHour;
}

function throwFirstError(results: Array<[Error | null, unknown]> | null): void {
  if (!results) throw new Error('Redis pipeline was discarded');
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis didn't answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
