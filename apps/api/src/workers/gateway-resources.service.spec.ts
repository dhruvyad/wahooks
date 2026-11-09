import { ConfigService } from '@nestjs/config';
import {
  GatewayResourcesService,
  GatewayRow,
  cpuUsage,
  indexServersByIp,
  memoryUsage,
  parsePrometheus,
  sessionUsage,
} from './gateway-resources.service';

const GIB = 1024 ** 3;
const TOKEN = 'test-hetzner-token';
const T0 = Date.parse('2026-11-10T12:00:00Z');

/** What a gateway's /metrics serves (trimmed). */
const GATEWAY_METRICS = `# HELP wagw_sessions Sessions by WAHA status.
# TYPE wagw_sessions gauge
wagw_sessions{status="WORKING"} 62
wagw_sessions{status="SCAN_QR_CODE"} 1
# HELP wagw_process_rss_bytes Resident set size.
# TYPE wagw_process_rss_bytes gauge
wagw_process_rss_bytes 59768832
# HELP wagw_go_heap_inuse_bytes Go heap in use.
# TYPE wagw_go_heap_inuse_bytes gauge
wagw_go_heap_inuse_bytes 3.1457280e+07
# HELP wagw_go_heap_live_bytes Go heap live after the last GC (runtime/metrics /gc/heap/live:bytes).
# TYPE wagw_go_heap_live_bytes gauge
wagw_go_heap_live_bytes 18874368
wagw_events_total{event="message"} 1200
`;

const cx23 = { name: 'cx23', cores: 2, memory: 4 };

/** The hand-made box: row `wagw-a`, server `wahooks-gw-1`. */
const SERVERS = [
  { id: 101, name: 'wahooks-gw-1', server_type: cx23, private_net: [{ network: 7, ip: '10.0.1.5' }] },
  { id: 102, name: 'wagw-0a1b2c3d', server_type: cx23, private_net: [{ network: 7, ip: '10.0.1.6' }] },
  {
    id: 200,
    name: 'k3s-agent',
    server_type: { name: 'cx33', cores: 4, memory: 8 },
    private_net: [{ network: 9, ip: '10.255.0.2' }],
  },
];

const row = (over: Partial<GatewayRow> = {}): GatewayRow => ({
  id: 'w1',
  podName: 'wagw-a',
  internalIp: '10.0.1.5',
  apiKeyEnc: 'gw-key-1',
  currentSessions: 62,
  maxSessions: 5000,
  ...over,
});

type Reply = { status?: number; body?: string } | Error;

const json = (body: unknown, status = 200): Reply => ({ status, body: JSON.stringify(body) });

/** CPU series as Hetzner returns it: summed across cores. */
const cpuSeries = (values: Array<[number, string]>) =>
  json({ metrics: { time_series: { cpu: { values } } } });

/**
 * A fetch that answers by URL: the server list, CPU metrics per server id and
 * each box's /metrics. Unrouted URLs fail the test.
 */
function makeFetch(routes: {
  list?: Reply | (() => Reply);
  cpu?: Record<number, Reply>;
  metrics?: Record<string, Reply>;
}) {
  const fn = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let reply: Reply | undefined;
    if (url.startsWith('https://api.hetzner.cloud/v1/servers?')) {
      reply = typeof routes.list === 'function' ? routes.list() : routes.list;
    } else {
      const cpu = /^https:\/\/api\.hetzner\.cloud\/v1\/servers\/(\d+)\/metrics\?/.exec(url);
      const box = /^http:\/\/([\d.]+):3000\/metrics$/.exec(url);
      if (cpu) reply = routes.cpu?.[Number(cpu[1])];
      else if (box) reply = routes.metrics?.[box[1]];
    }
    if (!reply) throw new Error(`unexpected fetch ${url} ${JSON.stringify(init?.method ?? 'GET')}`);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const body = reply.body ?? '';
    return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
  });
  return fn;
}

const urls = (fetch: jest.Mock) => fetch.mock.calls.map((c) => String(c[0]));

describe('utilization maths', () => {
  it('connections: current out of the cap, and no cap when max_sessions is 0', () => {
    expect(sessionUsage(62, 5000)).toEqual({ current: 62, max: 5000, pct: 1.2 });
    expect(sessionUsage(4000, 5000)).toEqual({ current: 4000, max: 5000, pct: 80 });
    expect(sessionUsage(12, 0)).toEqual({ current: 12, max: 0, pct: null });
  });

  it('CPU: Hetzner sums cores, so utilization is value / (cores × 100)', () => {
    // One busy core on a 2-core box reads ~100: half the server.
    expect(cpuUsage([[1000, '100']], 2)).toEqual({ pct: 50, avgPct5m: 50 });
    // 200 on 2 cores is every core busy.
    expect(cpuUsage([[1000, '200']], 2)).toEqual({ pct: 100, avgPct5m: 100 });
    expect(cpuUsage([[1000, '20']], 4)).toEqual({ pct: 5, avgPct5m: 5 });
  });

  it('CPU: latest value and the average of the 5 minutes before it, in time order', () => {
    const t = 1_700_000_000;
    const values: Array<[number, string]> = [
      [t + 240, '30'],
      [t - 600, '190'], // older than 5 minutes: ignored by the average
      [t, '10'],
      [t + 60, '20'],
      [t + 120, 'NaN'],
      [t + 180, '20'],
    ];
    // latest 30 / 2 = 15; average (10 + 20 + 20 + 30) / 4 = 20 → 10
    expect(cpuUsage(values, 2)).toEqual({ pct: 15, avgPct5m: 10 });
  });

  it('CPU: null without samples or cores', () => {
    expect(cpuUsage([], 2)).toBeNull();
    expect(cpuUsage([[1, 'NaN']], 2)).toBeNull();
    expect(cpuUsage([[1, '50']], 0)).toBeNull();
  });

  it('memory: RSS out of the server RAM (GB means GiB)', () => {
    expect(memoryUsage(1 * GIB, 4)).toEqual({ usedBytes: GIB, totalBytes: 4 * GIB, pct: 25 });
    expect(memoryUsage(59768832, 4)).toEqual({ usedBytes: 59768832, totalBytes: 4 * GIB, pct: 1.4 });
    expect(memoryUsage(59768832, null)).toEqual({ usedBytes: 59768832, totalBytes: null, pct: null });
    expect(memoryUsage(59768832, 0)).toEqual({ usedBytes: 59768832, totalBytes: null, pct: null });
  });
});

describe('parsePrometheus', () => {
  it('reads unlabelled gauges, skipping comments and labelled series', () => {
    const m = parsePrometheus(GATEWAY_METRICS);
    expect(m.get('wagw_process_rss_bytes')).toBe(59768832);
    expect(m.get('wagw_go_heap_live_bytes')).toBe(18874368);
    expect(m.get('wagw_go_heap_inuse_bytes')).toBe(31457280);
    expect(m.has('wagw_sessions')).toBe(false);
    expect(m.has('wagw_events_total')).toBe(false);
    expect(m.has('#')).toBe(false);
  });

  it('handles CRLF, timestamps, blanks and non-finite values', () => {
    const m = parsePrometheus('a 1 1700000000000\r\n\r\nb NaN\nc +Inf\nd -1\n  e 2.5e3  \ngarbage line here');
    expect(m.get('a')).toBe(1);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(false);
    expect(m.get('d')).toBe(-1);
    expect(m.get('e')).toBe(2500);
    expect(parsePrometheus('').size).toBe(0);
  });
});

describe('indexServersByIp', () => {
  it('maps private IPs to servers, whatever the row is called', () => {
    const byIp = indexServersByIp(SERVERS);
    expect(byIp.get('10.0.1.5')).toEqual({ id: 101, name: 'wahooks-gw-1', type: 'cx23', cores: 2, memoryGb: 4 });
    expect(byIp.get('10.0.1.6')?.name).toBe('wagw-0a1b2c3d');
    expect(byIp.get('10.255.0.2')?.cores).toBe(4);
    expect(byIp.has('10.0.1.9')).toBe(false);
  });

  it('keeps only the given network', () => {
    const byIp = indexServersByIp(SERVERS, 7);
    expect(byIp.has('10.0.1.5')).toBe(true);
    expect(byIp.has('10.255.0.2')).toBe(false);
  });

  it('marks an IP two servers share as ambiguous (null)', () => {
    const byIp = indexServersByIp([
      ...SERVERS,
      { id: 300, name: 'other', server_type: cx23, private_net: [{ network: 8, ip: '10.0.1.5' }] },
    ]);
    expect(byIp.get('10.0.1.5')).toBeNull();
    expect(indexServersByIp([...SERVERS, { ...SERVERS[0] }]).get('10.0.1.5')?.id).toBe(101);
  });
});

describe('GatewayResourcesService', () => {
  let clock: number;

  function build(fetch: jest.Mock, env: Record<string, string | undefined> = { HETZNER_API_TOKEN: TOKEN }) {
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    return new GatewayResourcesService(config, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      firstSampleWaitMs: 1_000,
    });
  }

  const healthy = () =>
    makeFetch({
      list: json({ servers: SERVERS, meta: { pagination: { next_page: null } } }),
      cpu: {
        101: cpuSeries([
          [T0 / 1000 - 240, '10'],
          [T0 / 1000 - 180, '30'],
          [T0 / 1000 - 120, '20'],
          [T0 / 1000 - 60, '20'],
        ]),
        102: cpuSeries([[T0 / 1000 - 60, '200']]),
      },
      metrics: {
        '10.0.1.5': { body: GATEWAY_METRICS },
        '10.0.1.6': { body: 'wagw_process_rss_bytes 2147483648\n' },
      },
    });

  beforeEach(() => {
    clock = T0;
  });

  it('collects CPU, memory, connections and server for each gateway', async () => {
    const fetch = healthy();
    const service = build(fetch);
    const rows = [row(), row({ id: 'w2', podName: 'wagw-0a1b2c3d', internalIp: '10.0.1.6', apiKeyEnc: 'gw-key-2', currentSessions: 0, maxSessions: 0 })];

    const res = await service.resourcesFor(rows);

    expect(res.get('w1')).toEqual({
      sampledAt: '2026-11-10T12:00:00.000Z',
      server: { name: 'wahooks-gw-1', type: 'cx23' },
      cpu: { pct: 10, avgPct5m: 10, cores: 2 },
      memory: { usedBytes: 59768832, totalBytes: 4 * GIB, pct: 1.4, heapLiveBytes: 18874368 },
      sessions: { current: 62, max: 5000, pct: 1.2 },
      errors: {},
    });
    expect(res.get('w2')).toEqual({
      sampledAt: '2026-11-10T12:00:00.000Z',
      server: { name: 'wagw-0a1b2c3d', type: 'cx23' },
      cpu: { pct: 100, avgPct5m: 100, cores: 2 },
      memory: { usedBytes: 2 * GIB, totalBytes: 4 * GIB, pct: 50 },
      sessions: { current: 0, max: 0, pct: null },
      errors: {},
    });
  });

  it('sends the token to Hetzner, the row key to the box, and asks for 5 minutes of CPU', async () => {
    const fetch = healthy();
    await build(fetch).resourcesFor([row()]);

    const hetzner = fetch.mock.calls.filter((c) => String(c[0]).startsWith('https://api.hetzner.cloud'));
    for (const [, init] of hetzner) {
      expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    }
    const cpuUrl = new URL(urls(fetch).find((u) => u.includes('/servers/101/metrics'))!);
    expect(Object.fromEntries(cpuUrl.searchParams)).toEqual({
      type: 'cpu',
      start: '2026-11-10T11:55:00Z',
      end: '2026-11-10T12:00:00Z',
      step: '60',
    });
    const box = fetch.mock.calls.find((c) => String(c[0]) === 'http://10.0.1.5:3000/metrics')!;
    expect((box[1] as RequestInit).headers).toEqual({ 'X-Api-Key': 'gw-key-1' });
  });

  it('only counts addresses on GATEWAY_NETWORK_ID when it is set', async () => {
    const fetch = healthy();
    const service = build(fetch, { HETZNER_API_TOKEN: TOKEN, GATEWAY_NETWORK_ID: '9' });
    const res = (await service.resourcesFor([row()])).get('w1')!;
    expect(res.server).toBeNull();
    expect(res.errors.server).toBe('no Hetzner server has private IP 10.0.1.5');
  });

  it('caches samples ~60 s and the server list ~10 min', async () => {
    const fetch = healthy();
    const service = build(fetch);
    const count = (part: string) => urls(fetch).filter((u) => u.includes(part)).length;

    await service.resourcesFor([row()]);
    expect(count('/v1/servers?')).toBe(1);
    expect(count('/servers/101/metrics')).toBe(1);
    expect(count(':3000/metrics')).toBe(1);

    // Within a minute: served from the cache, nothing fetched.
    clock += 30_000;
    const cached = await service.resourcesFor([row({ currentSessions: 63 })]);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Connections come from the row on every request.
    expect(cached.get('w1')!.sessions.current).toBe(63);
    expect(cached.get('w1')!.sampledAt).toBe('2026-11-10T12:00:00.000Z');

    // Over a minute: stale data is returned while a refresh runs in the background.
    clock += 31_000;
    const stale = await service.resourcesFor([row()]);
    expect(stale.get('w1')!.sampledAt).toBe('2026-11-10T12:00:00.000Z');
    await flush();
    expect(count('/servers/101/metrics')).toBe(2);
    expect(count(':3000/metrics')).toBe(2);
    expect(count('/v1/servers?')).toBe(1); // the server list is still fresh
    expect((await service.resourcesFor([row()])).get('w1')!.sampledAt).toBe('2026-11-10T12:01:01.000Z');

    // After 10 minutes the server list is fetched again.
    clock += 10 * 60_000;
    await service.resourcesFor([row()]);
    await flush();
    expect(count('/v1/servers?')).toBe(2);
  });

  it('re-lists servers (at most once a minute) for a gateway IP the cached list lacks', async () => {
    const fetch = healthy();
    const service = build(fetch);
    await service.resourcesFor([row()]);

    clock += 61_000;
    await service.resourcesFor([row(), row({ id: 'w3', internalIp: '10.0.1.99' })]);
    await flush();
    expect(urls(fetch).filter((u) => u.includes('/v1/servers?'))).toHaveLength(2);
  });

  it('runs one collection at a time', async () => {
    const fetch = healthy();
    const service = build(fetch);
    await Promise.all([service.resourcesFor([row()]), service.resourcesFor([row()])]);
    expect(urls(fetch).filter((u) => u.includes(':3000/metrics'))).toHaveLength(1);
  });

  it('does nothing for no gateways', async () => {
    const fetch = healthy();
    expect((await build(fetch).resourcesFor([])).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('failure paths', () => {
    it('without HETZNER_API_TOKEN: CPU and server are null, memory has no total, Hetzner is never called', async () => {
      const fetch = healthy();
      const res = (await build(fetch, {}).resourcesFor([row()])).get('w1')!;
      expect(res.server).toBeNull();
      expect(res.cpu).toBeNull();
      expect(res.memory).toEqual({ usedBytes: 59768832, totalBytes: null, pct: null, heapLiveBytes: 18874368 });
      expect(res.sessions.pct).toBe(1.2);
      expect(res.errors.server).toBe('HETZNER_API_TOKEN is not set');
      expect(res.errors.cpu).toBe('HETZNER_API_TOKEN is not set');
      expect(res.errors.memory).toMatch(/server size unknown/);
      expect(urls(fetch).some((u) => u.includes('hetzner'))).toBe(false);
    });

    it('Hetzner list failing: server and CPU null with the reason, memory still read, token never shown', async () => {
      const fetch = makeFetch({
        list: json({ error: { code: 'unavailable', message: 'service unavailable' } }, 503),
        metrics: { '10.0.1.5': { body: GATEWAY_METRICS } },
      });
      const res = (await build(fetch).resourcesFor([row()])).get('w1')!;
      expect(res.server).toBeNull();
      expect(res.cpu).toBeNull();
      expect(res.errors.server).toBe('Hetzner GET /servers failed (HTTP 503: service unavailable)');
      expect(res.errors.cpu).toBe(res.errors.server);
      expect(res.memory?.usedBytes).toBe(59768832);
      expect(res.memory?.totalBytes).toBeNull();
      expect(JSON.stringify(res)).not.toContain(TOKEN);
    });

    it('Hetzner unreachable: a network error is the reason, and the next refresh retries the list', async () => {
      let attempts = 0;
      const fetch = makeFetch({
        list: () => (++attempts === 1 ? new Error('fetch failed') : json({ servers: SERVERS })),
        cpu: { 101: cpuSeries([[T0 / 1000, '50']]) },
        metrics: { '10.0.1.5': { body: GATEWAY_METRICS } },
      });
      const service = build(fetch);
      expect((await service.resourcesFor([row()])).get('w1')!.errors.server).toBe('fetch failed');

      clock += 60_000;
      await service.resourcesFor([row()]);
      await flush();
      const res = (await service.resourcesFor([row()])).get('w1')!;
      expect(res.server?.name).toBe('wahooks-gw-1');
      expect(res.cpu).toEqual({ pct: 25, avgPct5m: 25, cores: 2 });
      expect(res.errors).toEqual({});
    });

    it('CPU metrics failing: CPU null, server and memory intact', async () => {
      const fetch = makeFetch({
        list: json({ servers: SERVERS }),
        cpu: { 101: json({ error: { message: 'rate limit exceeded' } }, 429) },
        metrics: { '10.0.1.5': { body: GATEWAY_METRICS } },
      });
      const res = (await build(fetch).resourcesFor([row()])).get('w1')!;
      expect(res.cpu).toBeNull();
      expect(res.errors.cpu).toBe('Hetzner GET /servers/101/metrics failed (HTTP 429: rate limit exceeded)');
      expect(res.server).toEqual({ name: 'wahooks-gw-1', type: 'cx23' });
      expect(res.memory?.pct).toBe(1.4);
      expect(res.errors.memory).toBeUndefined();
    });

    it('no CPU samples yet: CPU null', async () => {
      const fetch = makeFetch({
        list: json({ servers: SERVERS }),
        cpu: { 101: cpuSeries([]) },
        metrics: { '10.0.1.5': { body: GATEWAY_METRICS } },
      });
      const res = (await build(fetch).resourcesFor([row()])).get('w1')!;
      expect(res.cpu).toBeNull();
      expect(res.errors.cpu).toBe('no CPU samples in the last 5 minutes');
    });

    it('/metrics unreachable: memory null, CPU intact', async () => {
      const fetch = makeFetch({
        list: json({ servers: SERVERS }),
        cpu: { 101: cpuSeries([[T0 / 1000, '50']]) },
        metrics: { '10.0.1.5': new Error('The operation was aborted due to timeout') },
      });
      const res = (await build(fetch).resourcesFor([row()])).get('w1')!;
      expect(res.memory).toBeNull();
      expect(res.errors.memory).toBe('gateway /metrics unreachable: The operation was aborted due to timeout');
      expect(res.cpu?.pct).toBe(25);
    });

    it('/metrics answering an error status: memory null', async () => {
      const fetch = makeFetch({
        list: json({ servers: SERVERS }),
        cpu: { 101: cpuSeries([[T0 / 1000, '50']]) },
        metrics: { '10.0.1.5': { status: 502, body: 'bad gateway' } },
      });
      const res = (await build(fetch).resourcesFor([row()])).get('w1')!;
      expect(res.memory).toBeNull();
      expect(res.errors.memory).toBe('gateway /metrics answered 502');
    });

    it('/metrics without RSS (or the -1 it reports off Linux): memory null', async () => {
      for (const body of ['wagw_go_heap_live_bytes 1000\n', 'wagw_process_rss_bytes -1\n']) {
        const fetch = makeFetch({
          list: json({ servers: SERVERS }),
          cpu: { 101: cpuSeries([[T0 / 1000, '50']]) },
          metrics: { '10.0.1.5': { body } },
        });
        const res = (await build(fetch).resourcesFor([row()])).get('w1')!;
        expect(res.memory).toBeNull();
        expect(res.errors.memory).toBe('gateway /metrics has no wagw_process_rss_bytes');
      }
    });

    it('no server with the row IP: server and CPU null, memory without a total', async () => {
      const fetch = makeFetch({
        list: json({ servers: SERVERS }),
        metrics: { '10.0.9.9': { body: GATEWAY_METRICS } },
      });
      const res = (await build(fetch).resourcesFor([row({ internalIp: '10.0.9.9' })])).get('w1')!;
      expect(res.server).toBeNull();
      expect(res.cpu).toBeNull();
      expect(res.errors.server).toBe('no Hetzner server has private IP 10.0.9.9');
      expect(res.memory?.totalBytes).toBeNull();
    });

    it('a row without an internal IP: everything but connections null', async () => {
      const fetch = makeFetch({ list: json({ servers: SERVERS }) });
      const res = (await build(fetch).resourcesFor([row({ internalIp: null })])).get('w1')!;
      expect(res.server).toBeNull();
      expect(res.cpu).toBeNull();
      expect(res.memory).toBeNull();
      expect(res.errors.memory).toBe('worker row has no internal IP');
      expect(res.sessions).toEqual({ current: 62, max: 5000, pct: 1.2 });
    });

    it('a first collection slower than the wait: nulls now, numbers on a later request', async () => {
      jest.useFakeTimers();
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const inner = healthy();
        const fetch = jest.fn(async (...args: Parameters<typeof inner>) => {
          await gate;
          return inner(...args);
        });
        const service = build(fetch);
        const pending = service.resourcesFor([row()]);
        await jest.advanceTimersByTimeAsync(1_000);
        const first = (await pending).get('w1')!;
        expect(first.sampledAt).toBeNull();
        expect(first.cpu).toBeNull();
        expect(first.sessions.pct).toBe(1.2);

        release();
        await jest.advanceTimersByTimeAsync(0);
        expect((await service.resourcesFor([row()])).get('w1')!.cpu?.pct).toBe(10);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

/** Lets a background collection finish (every mock resolves without timers). */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
