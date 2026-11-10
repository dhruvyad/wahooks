/**
 * Why a connection is `failed`, in terms its owner can act on. Stored in `waha_sessions.status_reason` (JSON,
 * `reason` field) by the health cron and returned as `failureReason` on the connection.
 *
 * - `logged_out`: WhatsApp removed the linked device (Linked devices → Log out on the phone, or WhatsApp dropping
 *   every linked device). Its credentials are gone; only a new QR scan brings it back.
 * - `qr_expired`: a QR code was shown and nobody scanned it in time.
 */
export type FailureReason = 'logged_out' | 'qr_expired';

interface StatusChange {
  status?: unknown;
}

function parse(statusReason: string | null | undefined): Record<string, unknown> | null {
  if (!statusReason) return null;
  try {
    const v = JSON.parse(statusReason);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The reason recorded for a failed connection, or null when it isn't one an owner can act on (or isn't known). */
export function failureReasonOf(statusReason: string | null | undefined): FailureReason | null {
  const reason = parse(statusReason)?.reason;
  if (reason === 'logged_out') return 'logged_out';
  if (reason === 'qr_expired') return 'qr_expired';
  // Written by older API versions when an unscanned QR session was retired.
  if (typeof reason === 'string' && reason.startsWith('scan_qr_expired')) return 'qr_expired';
  return null;
}

/**
 * A gateway session that failed with no linked device either lost it (logged out) or never got one (its QR codes
 * ran out). The gateway's status history, which the session.status event stored moments before, tells them apart:
 * FAILED right after SCAN_QR_CODE is an expired QR, right after WORKING a logout. Without it, a connection that once
 * had a number was linked before.
 */
export function unlinkedFailureReason(
  statusReason: string | null | undefined,
  phoneNumber: string | null | undefined,
): FailureReason {
  const history = parse(statusReason)?.history;
  if (Array.isArray(history)) {
    const statuses = (history as StatusChange[]).map((h) => h?.status);
    const failedAt = statuses.lastIndexOf('FAILED');
    const before = failedAt > 0 ? statuses[failedAt - 1] : undefined;
    if (before === 'SCAN_QR_CODE') return 'qr_expired';
    if (before === 'WORKING') return 'logged_out';
  }
  return phoneNumber ? 'logged_out' : 'qr_expired';
}
