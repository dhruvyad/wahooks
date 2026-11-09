import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Optional overrides for tests: HTTP and the clock. */
export const GATEWAY_RESOURCES_DEPS = Symbol('GATEWAY_RESOURCES_DEPS');

export interface GatewayResourcesDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** How long the first request after boot waits for the first sample. */
  firstSampleWaitMs?: number;
}

/** The fields of a `waha_workers` gateway row the collector reads. */
export interface GatewayRow {
  id: string;
  podName: string | null;
  internalIp: string | null;
  apiKeyEnc: string;
  currentSessions: number;
  maxSessions: number;
}

/** Per-gateway utilization, as `GET /api/infrastructure` returns it under `resources`. */
export interface GatewayResources {
  /** When CPU and memory were sampled (they are cached ~60 s); null before the first sample. */
  sampledAt: string | null;
  server: { name: string; type: string } | null;
  /** Percentages of the whole server: 100 = every core busy. */
  cpu: { pct: number; avgPct5m: number; cores: number } | null;
  /** totalBytes and pct are null when the server's size is unknown. */
  memory: {
    usedBytes: number;
    totalBytes: number | null;
    pct: number | null;
    heapLiveBytes?: number;
  } | null;
  /** From the row's counters; pct is null when max is 0 (no cap). */
  sessions: { current: number; max: number; pct: number | null };
  /** Why a part above is null (or, for memory, has no total). */
  errors: { server?: string; cpu?: string; memory?: string };
}

/** A Hetzner server as the collector needs it. */
export interface ServerInfo {
  id: number;
  name: string;
  type: string;
  cores: number;
  /** RAM in GB as Hetzner gives it (GiB). */
  memoryGb: number;
}

interface HetznerServer {
  id: number;
  name: string;
  server_type?: { name?: string; cores?: number; memory?: number };
  private_net?: Array<{ network: number; ip: string }>;
}

/** CPU, memory and server parts of one gateway, cached between collections. */
type HostSample = Pick<GatewayResources, 'server' | 'cpu' | 'memory' | 'errors'> & {
  sampledAt: string;
};

const GIB = 1024 ** 3;
const CPU_WINDOW_S = 300;

const round1 = (n: number) => Math.round(n * 10) / 10;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Connections used out of the row's cap; a cap of 0 means none (pct null). */
export function sessionUsage(current: number, max: number): GatewayResources['sessions'] {
  return { current, max, pct: max > 0 ? round1((current / max) * 100) : null };
}

/**
 * Hetzner reports CPU summed across cores (one busy core on a 2-core server
 * reads ~100, all cores 200), so utilization is value / (cores × 100). Returns
 * the latest value and the average over the 5 minutes before it, or null
 * without usable samples.
 */
export function cpuUsage(
  values: Array<[number, string]>,
  cores: number,
): { pct: number; avgPct5m: number } | null {
  if (!(cores > 0)) return null;
  const points = values
    .map(([t, v]) => [Number(t), Number(v)] as const)
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (points.length === 0) return null;
  const [latestT, latest] = points[points.length - 1];
  const recent = points.filter(([t]) => t >= latestT - CPU_WINDOW_S).map(([, v]) => v);
  const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
  return { pct: round1(latest / cores), avgPct5m: round1(avg / cores) };
}

/** Resident memory out of the server's RAM (Hetzner gives it in GB, meaning GiB). */
export function memoryUsage(
  rssBytes: number,
  memoryGb: number | null,
): { usedBytes: number; totalBytes: number | null; pct: number | null } {
  if (memoryGb === null || !(memoryGb > 0)) {
    return { usedBytes: rssBytes, totalBytes: null, pct: null };
  }
  const totalBytes = Math.round(memoryGb * GIB);
  return { usedBytes: rssBytes, totalBytes, pct: round1((rssBytes / totalBytes) * 100) };
}

/**
 * Unlabelled samples of a Prometheus text exposition, by metric name (the
 * first sample wins). Comments, labelled series and non-finite values are
 * skipped.
 */
export function parsePrometheus(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\S+)/.exec(line);
    if (!m || out.has(m[1])) continue;
    const value = Number(m[2]);
    if (Number.isFinite(value)) out.set(m[1], value);
  }
  return out;
}

/**
 * Servers by private IP. With a network id, only addresses on that network
 * count. An IP two servers share maps to null (ambiguous: never guess).
 */
export function indexServersByIp(
  servers: HetznerServer[],
  networkId?: number,
): Map<string, ServerInfo | null> {
  const byIp = new Map<string, ServerInfo | null>();
  for (const s of servers) {
    const info: ServerInfo = {
      id: s.id,
      name: s.name,
      type: s.server_type?.name ?? 'unknown',
      cores: Number(s.server_type?.cores ?? 0),
      memoryGb: Number(s.server_type?.memory ?? 0),
    };
    for (const net of s.private_net ?? []) {
      if (!net.ip || (networkId !== undefined && net.network !== networkId)) continue;
      byIp.set(net.ip, byIp.has(net.ip) && byIp.get(net.ip)?.id !== s.id ? null : info);
    }
  }
  return byIp;
}

/**
 * CPU, memory and connection utilization of each gateway box, for the admin
 * Infrastructure page. Collected on demand and cached ~60 s, so the page's
 * polling never reaches Hetzner more than once a minute (its rate limit is
 * shared with the gateway orchestrator); the IP → server index is cached ~10
 * min. A source that fails leaves its part null with a reason, never an error.
 *
 * Sources: Hetzner's server list (size) and CPU metrics, and each box's
 * `GET /metrics` (`wagw_process_rss_bytes`, `wagw_go_heap_live_bytes`).
 */
@Injectable()
export class GatewayResourcesService {
  private readonly logger = new Logger(GatewayResourcesService.name);
  private readonly apiBase = 'https://api.hetzner.cloud/v1';
  private readonly token: string | undefined;
  private readonly networkId: number | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly firstSampleWaitMs: number;

  readonly sampleTtlMs = 60_000;
  readonly serverIndexTtlMs = 10 * 60_000;
  /** A gateway IP missing from the index re-lists servers, at most this often. */
  private readonly missingIpRelistMs = 60_000;
  private readonly requestTimeoutMs = 5_000;

  private samples = new Map<string, HostSample>();
  private sampledAt = 0;
  private refreshing: Promise<void> | null = null;
  private serverIndex: { byIp: Map<string, ServerInfo | null>; fetchedAt: number } | null = null;
  /** What was last logged per worker, so a lasting failure logs once. */
  private loggedErrors = new Map<string, string>();

  constructor(
    configService: ConfigService,
    @Optional() @Inject(GATEWAY_RESOURCES_DEPS) deps: GatewayResourcesDeps = {},
  ) {
    this.token = configService.get<string>('HETZNER_API_TOKEN')?.trim() || undefined;
    const network = configService.get<string>('GATEWAY_NETWORK_ID')?.trim();
    this.networkId = network && /^\d+$/.test(network) ? Number(network) : undefined;
    this.fetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.now = deps.now ?? Date.now;
    this.firstSampleWaitMs = deps.firstSampleWaitMs ?? 3_000;
  }

  /**
   * Utilization of each row, by worker id. Starts a collection in the
   * background when the cached one is over a minute old; only the first
   * request after boot waits for it, and at most a few seconds.
   */
  async resourcesFor(rows: GatewayRow[]): Promise<Map<string, GatewayResources>> {
    if (rows.length > 0 && this.now() - this.sampledAt >= this.sampleTtlMs && !this.refreshing) {
      this.refreshing = this.collect(rows)
        .catch((error) => this.logger.warn(`Gateway resource collection failed: ${message(error)}`))
        .finally(() => {
          this.refreshing = null;
        });
    }
    if (this.refreshing && this.sampledAt === 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.refreshing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.firstSampleWaitMs);
        }),
      ]);
      clearTimeout(timer);
    }

    return new Map(
      rows.map((row) => {
        const sample = this.samples.get(row.id);
        return [
          row.id,
          {
            sampledAt: sample?.sampledAt ?? null,
            server: sample?.server ?? null,
            cpu: sample?.cpu ?? null,
            memory: sample?.memory ?? null,
            sessions: sessionUsage(row.currentSessions, row.maxSessions),
            errors: sample?.errors ?? {},
          },
        ];
      }),
    );
  }

  /** Samples every row now and replaces the cache. Never throws for one failing source. */
  async collect(rows: GatewayRow[]): Promise<void> {
    const index = await this.serversFor(rows);
    const entries = await Promise.all(
      rows.map(async (row) => [row.id, await this.sample(row, index)] as const),
    );
    this.samples = new Map(entries);
    this.sampledAt = this.now();
  }

  private async sample(
    row: GatewayRow,
    index: { byIp: Map<string, ServerInfo | null> } | { error: string },
  ): Promise<HostSample> {
    const errors: HostSample['errors'] = {};

    let server: ServerInfo | null = null;
    if ('error' in index) {
      errors.server = index.error;
    } else if (!row.internalIp) {
      errors.server = 'worker row has no internal IP';
    } else {
      const found = index.byIp.get(row.internalIp);
      if (found) server = found;
      else
        errors.server =
          found === null
            ? `more than one Hetzner server has private IP ${row.internalIp}`
            : `no Hetzner server has private IP ${row.internalIp}`;
    }

    const [cpuResult, memResult] = await Promise.all([
      server ? this.cpu(server) : Promise.resolve({ error: errors.server! }),
      this.memory(row),
    ]);

    let cpu: HostSample['cpu'] = null;
    if ('error' in cpuResult) errors.cpu = cpuResult.error;
    else cpu = cpuResult;

    let memory: HostSample['memory'] = null;
    if ('error' in memResult) {
      errors.memory = memResult.error;
    } else {
      memory = {
        ...memoryUsage(memResult.rssBytes, server ? server.memoryGb : null),
        ...(memResult.heapLiveBytes !== undefined ? { heapLiveBytes: memResult.heapLiveBytes } : {}),
      };
      if (memory.totalBytes === null) errors.memory = `server size unknown: ${errors.server}`;
    }

    this.logChanges(row, errors, memory !== null);
    return {
      sampledAt: new Date(this.now()).toISOString(),
      server: server ? { name: server.name, type: server.type } : null,
      cpu,
      memory,
      errors,
    };
  }

  /** The cached IP → server index, re-listed when stale or missing one of the rows' IPs. */
  private async serversFor(
    rows: GatewayRow[],
  ): Promise<{ byIp: Map<string, ServerInfo | null> } | { error: string }> {
    if (!this.token) return { error: 'HETZNER_API_TOKEN is not set' };
    const now = this.now();
    const cached = this.serverIndex;
    const fresh = cached && now - cached.fetchedAt < this.serverIndexTtlMs;
    const missing =
      cached &&
      rows.some((r) => r.internalIp && !cached.byIp.has(r.internalIp)) &&
      now - cached.fetchedAt >= this.missingIpRelistMs;
    if (fresh && !missing) return cached;
    try {
      const servers: HetznerServer[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await this.hetzner<{
          servers: HetznerServer[];
          meta?: { pagination?: { next_page: number | null } };
        }>(`/servers?per_page=50&page=${page}`);
        servers.push(...(res.servers ?? []));
        if (!res.meta?.pagination?.next_page) break;
      }
      this.serverIndex = { byIp: indexServersByIp(servers, this.networkId), fetchedAt: now };
      return this.serverIndex;
    } catch (error) {
      return { error: message(error) };
    }
  }

  private async cpu(
    server: ServerInfo,
  ): Promise<{ pct: number; avgPct5m: number; cores: number } | { error: string }> {
    if (!(server.cores > 0)) return { error: `server type ${server.type} reports no cores` };
    const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const end = this.now();
    const query = new URLSearchParams({
      type: 'cpu',
      start: rfc3339(end - CPU_WINDOW_S * 1000),
      end: rfc3339(end),
      step: '60',
    });
    try {
      const res = await this.hetzner<{
        metrics?: { time_series?: { cpu?: { values?: Array<[number, string]> } } };
      }>(`/servers/${server.id}/metrics?${query}`);
      const usage = cpuUsage(res.metrics?.time_series?.cpu?.values ?? [], server.cores);
      if (!usage) return { error: 'no CPU samples in the last 5 minutes' };
      return { ...usage, cores: server.cores };
    } catch (error) {
      return { error: message(error) };
    }
  }

  /** RSS (and live heap) from the box's Prometheus endpoint. */
  private async memory(
    row: GatewayRow,
  ): Promise<{ rssBytes: number; heapLiveBytes?: number } | { error: string }> {
    if (!row.internalIp) return { error: 'worker row has no internal IP' };
    try {
      // /metrics needs no key on the gateway today; send it anyway, as the
      // rest of the API does, in case that changes.
      const res = await this.fetch(`http://${row.internalIp}:3000/metrics`, {
        headers: { 'X-Api-Key': row.apiKeyEnc },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!res.ok) return { error: `gateway /metrics answered ${res.status}` };
      const metrics = parsePrometheus(await res.text());
      const rss = metrics.get('wagw_process_rss_bytes');
      if (rss === undefined || rss < 0) {
        return { error: 'gateway /metrics has no wagw_process_rss_bytes' };
      }
      const heap = metrics.get('wagw_go_heap_live_bytes');
      return { rssBytes: rss, ...(heap !== undefined && heap >= 0 ? { heapLiveBytes: heap } : {}) };
    } catch (error) {
      return { error: `gateway /metrics unreachable: ${message(error)}` };
    }
  }

  private async hetzner<T>(path: string): Promise<T> {
    const res = await this.fetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.error?.message === 'string') detail += `: ${parsed.error.message}`;
      } catch {
        // not JSON: the status is enough
      }
      throw new Error(`Hetzner GET ${path.split('?')[0]} failed (${detail})`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Logs a gateway's distinct failure causes when they change (a missing server size isn't one). */
  private logChanges(row: GatewayRow, errors: HostSample['errors'], hasMemory: boolean): void {
    const causes = [
      ...new Set([errors.server, errors.cpu, hasMemory ? undefined : errors.memory]),
    ]
      .filter(Boolean)
      .join('; ');
    if (causes && this.loggedErrors.get(row.id) !== causes) {
      this.logger.warn(`Gateway ${row.podName ?? row.id} utilization incomplete: ${causes}`);
    }
    if (causes) this.loggedErrors.set(row.id, causes);
    else this.loggedErrors.delete(row.id);
  }
}
