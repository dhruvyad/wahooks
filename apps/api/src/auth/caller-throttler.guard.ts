import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';

/**
 * Two rate limits, each per route and per minute:
 * - `default`, 60: per caller and connection, so one busy connection can't use up a platform token's allowance for
 *   all its others (a token like NoClick's serves hundreds of connections).
 * - `caller`, 1,000: per caller across its connections, a ceiling that a caller naming many (or made-up) connection
 *   ids can't get past.
 */
export const RATE_LIMITS = [
  { name: 'default', ttl: 60_000, limit: 60 },
  { name: 'caller', ttl: 60_000, limit: 1_000, getTracker: (req: Record<string, any>) => callerOf(req) },
];

/** For `@SkipThrottle(...)`: routes that must never be rate-limited (health probes, internal event ingestion). */
export const NO_RATE_LIMIT = { default: true, caller: true };

/**
 * Who is calling. Every request reaches the API through Traefik, so `req.ip` is Traefik's pod IP for all customers
 * and the default tracker put everyone in one shared bucket. Authenticated requests are bucketed by a hash of their
 * bearer token (an API token or a dashboard JWT). This guard runs before AuthGuard, so the token is only a bucket key
 * here; an invalid token still gets rejected by AuthGuard.
 */
export function callerOf(req: Record<string, any>): string {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7) {
    const digest = createHash('sha256').update(auth.slice(7)).digest('hex');
    return `token:${digest.slice(0, 32)}`;
  }
  return req.ip;
}

@Injectable()
export class CallerThrottlerGuard extends ThrottlerGuard {
  /** The `default` limit's bucket: the caller, and the connection (or other resource) the route names. */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const caller = callerOf(req);
    const resource = req.params?.connectionId ?? req.params?.id;
    return typeof resource === 'string' && resource ? `${caller}|${resource.slice(0, 64)}` : caller;
  }
}
