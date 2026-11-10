import { failureReasonOf, unlinkedFailureReason } from './failure-reason';

const events = (...statuses: string[]) =>
  JSON.stringify({ via: 'waha_event', history: statuses.map((status) => ({ status, timestamp: 1 })) });

describe('failureReasonOf', () => {
  it('reads the reason the health check recorded', () => {
    expect(failureReasonOf(JSON.stringify({ via: 'health_cron', reason: 'logged_out' }))).toBe('logged_out');
    expect(failureReasonOf(JSON.stringify({ via: 'health_cron', reason: 'qr_expired' }))).toBe('qr_expired');
    expect(failureReasonOf(JSON.stringify({ via: 'health_cron', reason: 'scan_qr_expired after 31 min unscanned' }))).toBe('qr_expired');
  });

  it('is null for anything else', () => {
    expect(failureReasonOf(null)).toBeNull();
    expect(failureReasonOf('not json')).toBeNull();
    expect(failureReasonOf(events('WORKING', 'FAILED'))).toBeNull();
    expect(failureReasonOf(JSON.stringify({ reason: 'recovery_exhausted after 5 restart attempts (WAHA FAILED)' }))).toBeNull();
  });
});

describe('unlinkedFailureReason', () => {
  it('FAILED right after WORKING is a logout', () => {
    expect(unlinkedFailureReason(events('STARTING', 'WORKING', 'FAILED'), null)).toBe('logged_out');
  });

  it('FAILED right after SCAN_QR_CODE is an expired QR, whatever number the connection had', () => {
    expect(unlinkedFailureReason(events('SCAN_QR_CODE', 'SCAN_QR_CODE', 'FAILED'), '4470000')).toBe('qr_expired');
  });

  it('otherwise goes by whether the connection was ever linked', () => {
    expect(unlinkedFailureReason(events('STARTING', 'FAILED'), '4470000')).toBe('logged_out');
    expect(unlinkedFailureReason(events('STARTING', 'FAILED'), null)).toBe('qr_expired');
    expect(unlinkedFailureReason(null, '4470000')).toBe('logged_out');
    expect(unlinkedFailureReason('garbage', null)).toBe('qr_expired');
  });
});
