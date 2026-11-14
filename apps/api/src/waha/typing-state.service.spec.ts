import { Queue } from 'bullmq';
import {
  RECENT_INBOUND_MS,
  TYPING_KEEPALIVE_MAX_MS,
  TYPING_KEEPALIVE_MS,
  TYPING_TTL_MS,
  TypingStateService,
  chatKey,
} from './typing-state.service';

/** The few Redis commands the typing state uses, with expiry on a fake clock. */
class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly strings = new Map<string, string>();
  readonly expiresAt = new Map<string, number>();

  private live(key: string): boolean {
    const at = this.expiresAt.get(key);
    if (at !== undefined && Date.now() >= at) {
      this.hashes.delete(key);
      this.strings.delete(key);
      this.expiresAt.delete(key);
    }
    return this.hashes.has(key) || this.strings.has(key);
  }

  async hget(key: string, field: string) {
    return this.live(key) ? (this.hashes.get(key)?.get(field) ?? null) : null;
  }
  async get(key: string) {
    return this.live(key) ? (this.strings.get(key) ?? null) : null;
  }
  async set(key: string, value: string, _px: 'PX', ms: number) {
    this.strings.set(key, value);
    this.expiresAt.set(key, Date.now() + ms);
    return 'OK';
  }
  async del(key: string) {
    const had = this.live(key);
    this.hashes.delete(key);
    this.expiresAt.delete(key);
    return had ? 1 : 0;
  }
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      hsetnx: (key: string, field: string, value: string) => {
        ops.push(() => {
          this.live(key);
          const h = this.hashes.get(key) ?? new Map<string, string>();
          if (!h.has(field)) h.set(field, value);
          this.hashes.set(key, h);
        });
        return chain;
      },
      hset: (key: string, field: string, value: string) => {
        ops.push(() => {
          this.live(key);
          const h = this.hashes.get(key) ?? new Map<string, string>();
          h.set(field, value);
          this.hashes.set(key, h);
        });
        return chain;
      },
      pexpire: (key: string, ms: number) => {
        ops.push(() => {
          if (this.hashes.has(key)) this.expiresAt.set(key, Date.now() + ms);
        });
        return chain;
      },
      exec: async () => ops.map((op) => [null, op()]),
    };
    return chain;
  }
}

describe('TypingStateService', () => {
  let redis: FakeRedis;
  let typing: TypingStateService;
  const refresh = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    redis = new FakeRedis();
    typing = new TypingStateService({ client: Promise.resolve(redis) } as unknown as Queue);
    refresh.mockClear();
  });

  afterEach(() => {
    typing.onModuleDestroy();
    jest.useRealTimers();
  });

  it('credits how long typing has shown, in a chat that messaged in the last 24 h', async () => {
    await typing.inbound('s', '5511987654321@s.whatsapp.net');
    await typing.started('s', '5511987654321@c.us', refresh);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(await typing.credit('s', '5511987654321@c.us')).toBe(4_000);
  });

  it('gives no credit to a cold chat, typing or not', async () => {
    await typing.started('s', '111@c.us', refresh);
    expect(await typing.credit('s', '111@c.us')).toBeNull();

    await typing.inbound('s', '111@c.us');
    jest.setSystemTime(Date.now() + RECENT_INBOUND_MS + 1);
    await typing.started('s', '111@c.us', refresh);
    expect(await typing.credit('s', '111@c.us')).toBeNull();
  });

  it('gives no credit once typing is stopped or a send cleared it', async () => {
    await typing.inbound('s', '111@c.us');
    await typing.started('s', '111@c.us', refresh);
    await typing.cleared('s', '111@c.us');
    expect(await typing.credit('s', '111@c.us')).toBeNull();
  });

  it('keeps the start time when the caller refreshes typing', async () => {
    await typing.inbound('s', '111@c.us');
    await typing.started('s', '111@c.us', refresh);
    await jest.advanceTimersByTimeAsync(5_000);
    await typing.started('s', '111@c.us', refresh);
    expect(await typing.credit('s', '111@c.us')).toBe(5_000);
  });

  it('keeps typing alive every 10 s for up to 2 minutes, then lets it lapse', async () => {
    await typing.inbound('s', '111@c.us');
    await typing.started('s', '111@c.us', refresh);

    await jest.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await typing.credit('s', '111@c.us')).toBe(70_000); // still live past the 25 s expiry

    await jest.advanceTimersByTimeAsync(TYPING_KEEPALIVE_MAX_MS);
    const calls = refresh.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(TYPING_KEEPALIVE_MAX_MS / TYPING_KEEPALIVE_MS);
    await jest.advanceTimersByTimeAsync(TYPING_TTL_MS);
    expect(await typing.credit('s', '111@c.us')).toBeNull();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(calls);
  });

  it('stops the keep-alive when typing is cleared', async () => {
    await typing.started('s', '111@c.us', refresh);
    await typing.cleared('s', '111@c.us');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('gives no credit when Redis is down, so the send gets the full delay', async () => {
    const down = new TypingStateService({ client: Promise.reject(new Error('down')) } as unknown as Queue);
    expect(await down.credit('s', '111@c.us')).toBeNull();
    await expect(down.started('s', '111@c.us', refresh)).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(refresh).not.toHaveBeenCalled();
    down.onModuleDestroy();
  });

  it('keys a chat the same however its id is written', () => {
    expect(chatKey('5511987654321@s.whatsapp.net')).toBe('5511987654321@c.us');
    expect(chatKey('+5511987654321')).toBe('5511987654321@c.us');
    expect(chatKey('5511987654321:12@s.whatsapp.net')).toBe('5511987654321@c.us');
    expect(chatKey('123456@lid')).toBe('123456@lid');
    expect(chatKey('120363000000000000@g.us')).toBe('120363000000000000@g.us');
  });
});
