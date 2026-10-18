import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';

/**
 * Rate-limits per caller instead of per IP.
 *
 * Every request reaches the API through Traefik, so `req.ip` is Traefik's pod IP
 * for all customers and the default tracker put everyone in one shared bucket.
 * Authenticated requests are bucketed by a hash of their bearer token (an API
 * token or a dashboard JWT), so one customer's burst can't throttle another's.
 * This guard runs before AuthGuard, so the token is only a bucket key here; an
 * invalid token still gets rejected by AuthGuard.
 */
@Injectable()
export class CallerThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth = req.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7) {
      const digest = createHash('sha256').update(auth.slice(7)).digest('hex');
      return `token:${digest.slice(0, 32)}`;
    }
    return req.ip;
  }
}
