import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/** WhatsApp stops showing "typing…" about 25 s after the last composing update. */
export const TYPING_TTL_MS = 25_000;
/** While a caller's typing is open, composing is re-sent this often so it doesn't lapse… */
export const TYPING_KEEPALIVE_MS = 10_000;
/** …for at most this long after it started; after that it lapses unless the caller refreshes it. */
export const TYPING_KEEPALIVE_MAX_MS = 2 * 60_000;
/** A chat that sent us a message this recently is a conversation, not a cold contact. */
export const RECENT_INBOUND_MS = 24 * 60 * 60_000;

const REDIS_TIMEOUT_MS = 1_000;
const FAILED = Symbol('redis failed');

type RedisClient = Awaited<Queue['client']>;

/**
 * Typing a caller showed before a send counts toward that send's human-like delay.
 *
 * Every send shows typing for 1–3 s plus 50 ms per character (at most 5 s) first, so an agent's reply waited ~7 s
 * after it was ready. A caller can start typing (POST /connections/:id/typing) as soon as a message reaches it; the
 * send then waits only for what's left of that delay. Only in a conversation: a chat that hasn't messaged the
 * connection in the last 24 h gets the full delay, typing or not.
 *
 * State lives in Redis (the webhook queue's connection), keyed by session and chat:
 * - `wahooks:typing:<session>:<chat>` hash {since, at}: when the caller's typing started and was last refreshed;
 *   expires 25 s after the last refresh, as WhatsApp's indicator does. Cleared by stop-typing and by any send.
 * - `wahooks:inbound:<session>:<chat>`: when the chat last sent a message; expires after 24 h.
 * Keep-alive timers are per pod; each tick re-checks Redis, so a stop or send handled by another pod ends them.
 * Without Redis every send gets the full delay.
 */
@Injectable()
export class TypingStateService implements OnModuleDestroy {
  private readonly logger = new Logger(TypingStateService.name);
  private readonly keepAlives = new Map<string, NodeJS.Timeout>();
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;

  constructor(@InjectQueue('webhook-delivery') private readonly queue: Queue) {}

  /**
   * The caller showed typing (it was just sent). Starts the record, or refreshes it keeping its start, and keeps
   * composing alive with `refresh` until it's cleared or TYPING_KEEPALIVE_MAX_MS have passed.
   */
  async started(session: string, chatId: string, refresh: () => Promise<void>, now = Date.now()): Promise<void> {
    const key = typingKey(session, chatId);
    const done = await this.run((redis) =>
      redis.multi().hsetnx(key, 'since', String(now)).hset(key, 'at', String(now)).pexpire(key, TYPING_TTL_MS).exec(),
    );
    if (done !== FAILED && !this.keepAlives.has(key)) this.keepAlive(key, refresh);
  }

  /** Typing ended (stop-typing, or a send). Never rejects. */
  async cleared(session: string, chatId: string): Promise<void> {
    const key = typingKey(session, chatId);
    this.stopKeepAlive(key);
    await this.run((redis) => redis.del(key));
  }

  /**
   * How long the caller's typing has shown in this chat, when it counts toward the send delay: typing is live and
   * the chat messaged the connection in the last 24 h. Null otherwise, or when Redis can't be read.
   */
  async credit(session: string, chatId: string, now = Date.now()): Promise<number | null> {
    const read = await this.run((redis) =>
      Promise.all([redis.hget(typingKey(session, chatId), 'since'), redis.get(inboundKey(session, chatId))]),
    );
    if (read === FAILED) return null;
    const since = read[0] === null ? NaN : Number(read[0]);
    const inbound = read[1] === null ? NaN : Number(read[1]);
    if (!Number.isFinite(since) || !Number.isFinite(inbound)) return null;
    if (now - inbound > RECENT_INBOUND_MS) return null;
    return Math.max(0, now - since);
  }

  /** The chat sent the connection a message. Never rejects. */
  async inbound(session: string, chatId: string, now = Date.now()): Promise<void> {
    await this.run((redis) => redis.set(inboundKey(session, chatId), String(now), 'PX', RECENT_INBOUND_MS));
  }

  onModuleDestroy(): void {
    for (const timer of this.keepAlives.values()) clearInterval(timer);
    this.keepAlives.clear();
  }

  private keepAlive(key: string, refresh: () => Promise<void>): void {
    const timer = setInterval(() => {
      void this.tick(key, refresh);
    }, TYPING_KEEPALIVE_MS);
    timer.unref?.();
    this.keepAlives.set(key, timer);
  }

  private async tick(key: string, refresh: () => Promise<void>): Promise<void> {
    const v = await this.run((redis) => redis.hget(key, 'since'));
    if (v === FAILED) return; // Redis hiccup: try again next tick; the record's own expiry still bounds it
    const since = v === null ? NaN : Number(v);
    if (!Number.isFinite(since) || Date.now() - since >= TYPING_KEEPALIVE_MAX_MS) {
      this.stopKeepAlive(key);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      this.logFailure(`Couldn't refresh typing: ${message(err)}`);
      return;
    }
    await this.run((redis) => redis.multi().hset(key, 'at', String(Date.now())).pexpire(key, TYPING_TTL_MS).exec());
  }

  private stopKeepAlive(key: string): void {
    const timer = this.keepAlives.get(key);
    if (timer) clearInterval(timer);
    this.keepAlives.delete(key);
  }

  /** Runs one Redis step with a timeout; FAILED (logged at most once a minute) when it fails. */
  private async run<T>(step: (redis: RedisClient) => Promise<T>): Promise<T | typeof FAILED> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const redis = await this.queue.client;
      return await Promise.race([
        step(redis),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Redis took over ${REDIS_TIMEOUT_MS} ms`)), REDIS_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      this.logFailure(`Typing state unavailable: ${message(err)}`);
      return FAILED;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private logFailure(text: string): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < 60_000) return;
    this.lastFailureLogAt = now;
    this.logger.warn(text);
  }
}

/**
 * One key per chat however it's written: phone-number chats (`@c.us`, `@s.whatsapp.net`, bare digits) by number,
 * device suffix dropped; `@lid` and `@g.us` as given.
 */
export function chatKey(chatId: string): string {
  const id = chatId.trim();
  const at = id.lastIndexOf('@');
  const server = at === -1 ? 'c.us' : id.slice(at + 1).toLowerCase();
  const user = (at === -1 ? id : id.slice(0, at)).split(':')[0];
  if (server === 'c.us' || server === 's.whatsapp.net') return `${user.replace(/\D/g, '')}@c.us`;
  return `${user}@${server}`;
}

function typingKey(session: string, chatId: string): string {
  return `wahooks:typing:${session}:${chatKey(chatId)}`;
}

function inboundKey(session: string, chatId: string): string {
  return `wahooks:inbound:${session}:${chatKey(chatId)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
