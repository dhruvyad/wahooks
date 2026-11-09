import { createHash, timingSafeEqual } from 'crypto';

/**
 * Header a worker sends with every event it POSTs to /api/events/waha. Gateway
 * sessions are created with it (webhook `customHeaders`) when EVENTS_SECRET is
 * set, and the endpoint then refuses gateway events without it.
 */
export const EVENTS_SECRET_HEADER = 'X-WAHooks-Events-Secret';

const EVENTS_PATH = '/api/events/waha';

/** Constant-time comparison; hashing first hides the expected length too. */
export function eventsSecretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** True for a webhook URL that points at WAHooks' own event ingestion. */
export function isEventsWebhookUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === EVENTS_PATH;
  } catch {
    return false;
  }
}

type Header = { name: string; value: string };
type Webhook = { url?: unknown; customHeaders?: Header[]; [key: string]: unknown };

/**
 * The session config with the events secret on every webhook that points at
 * WAHooks, or null when each of them already carries it (or there is none).
 * Every other part of the config is kept as it is.
 */
export function withEventsSecretHeader(
  config: Record<string, unknown> | null | undefined,
  secret: string,
): Record<string, unknown> | null {
  const webhooks = Array.isArray(config?.webhooks) ? (config!.webhooks as Webhook[]) : [];
  const isOurs = (h: Header) => h?.name?.toLowerCase() === EVENTS_SECRET_HEADER.toLowerCase();
  const stale = webhooks.filter(
    (w) =>
      isEventsWebhookUrl(w?.url) &&
      !(w.customHeaders ?? []).some((h) => isOurs(h) && h.value === secret),
  );
  if (stale.length === 0) return null;
  return {
    ...config,
    webhooks: webhooks.map((w) =>
      stale.includes(w)
        ? {
            ...w,
            customHeaders: [
              ...(w.customHeaders ?? []).filter((h) => !isOurs(h)),
              { name: EVENTS_SECRET_HEADER, value: secret },
            ],
          }
        : w,
    ),
  };
}
