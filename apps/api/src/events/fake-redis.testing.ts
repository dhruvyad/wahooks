import { Queue } from 'bullmq';

/**
 * An in-memory stand-in for the few Redis hash commands the event counters use,
 * behind ioredis' pipeline API. For specs only (excluded from the build).
 */
export class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly ttls = new Map<string, number>();
  /** Every command queued, in order: [name, key, ...args]. */
  readonly commands: unknown[][] = [];
  /** Pipelines executed: one per round trip. */
  execs = 0;

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  /** The commands of one name, e.g. `hgetall`. */
  named(name: string): unknown[][] {
    return this.commands.filter(([n]) => n === name);
  }
}

export class FakePipeline {
  private readonly ops: Array<() => unknown> = [];

  constructor(private readonly redis: FakeRedis) {}

  hincrby(key: string, field: string, by: number): this {
    return this.queue(['hincrby', key, field, by], () => {
      const hash = this.redis.hashes.get(key) ?? new Map<string, string>();
      const next = Number(hash.get(field) ?? 0) + by;
      hash.set(field, String(next));
      this.redis.hashes.set(key, hash);
      return next;
    });
  }

  expire(key: string, seconds: number): this {
    return this.queue(['expire', key, seconds], () => {
      if (!this.redis.hashes.has(key)) return 0;
      this.redis.ttls.set(key, seconds);
      return 1;
    });
  }

  hgetall(key: string): this {
    return this.queue(['hgetall', key], () => Object.fromEntries(this.redis.hashes.get(key) ?? []));
  }

  hmget(key: string, ...fields: string[]): this {
    return this.queue(['hmget', key, ...fields], () =>
      fields.map((f) => this.redis.hashes.get(key)?.get(f) ?? null),
    );
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    this.redis.execs++;
    return this.ops.map((op) => {
      try {
        return [null, op()];
      } catch (err) {
        return [err as Error, null];
      }
    });
  }

  private queue(command: unknown[], op: () => unknown): this {
    this.redis.commands.push(command);
    this.ops.push(op);
    return this;
  }
}

/** A `webhook-delivery` queue whose Redis connection is `client`. */
export function queueWith(client: unknown): Queue {
  return { client: Promise.resolve(client) } as unknown as Queue;
}

/** A queue whose Redis connection fails with `error` each time it is asked for. */
export function failingQueue(error: Error): Queue {
  return {
    get client() {
      return Promise.reject(error);
    },
  } as unknown as Queue;
}

/** A queue whose Redis connection never becomes ready. */
export function hangingQueue(): Queue {
  return {
    get client() {
      return new Promise(() => undefined);
    },
  } as unknown as Queue;
}
