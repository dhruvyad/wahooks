import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ContainerOrchestrator,
  ProvisionHooks,
  ProvisionResult,
} from './orchestrator.interface';
import { buildGatewayUserData } from './gateway-cloud-init';

export interface GatewayOrchestratorConfig {
  token: string;
  networkId: number;
  firewallId?: number;
  sshKeys: string[];
  serverType: string;
  location: string;
  binaryUrl: string;
  binarySha256: string;
  dbUrl: string;
  dbMaxConns: number;
  webhookResolve?: string;
}

export interface GatewayOrchestratorDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface HetznerServer {
  id: number;
  name: string;
  status: string; // initializing | starting | running | stopping | off | deleting | ...
  created: string;
  private_net?: Array<{ network: number; ip: string }>;
}

/** Hetzner label every gateway box carries; listing and adoption go by it. */
export const GATEWAY_LABEL = { key: 'role', value: 'wagw' } as const;

/** Env a configured GatewayOrchestrator needs; the rest have defaults. */
export const GATEWAY_REQUIRED_ENV = [
  'HETZNER_API_TOKEN',
  'GATEWAY_NETWORK_ID',
  'GATEWAY_BINARY_URL',
  'GATEWAY_BINARY_SHA256',
  'GATEWAY_DB_URL',
] as const;

/**
 * Gateway boxes (gateway/, the WAHA-compatible Go gateway) as Hetzner Cloud
 * servers: Ubuntu 24.04 set up by cloud-init (see gateway-cloud-init.ts), on
 * the API's private network, sharing one Postgres store. Each box gets its own
 * random API key, generated here and persisted through `onCreated` before the
 * box is waited on.
 */
export class GatewayOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(GatewayOrchestrator.name);
  private readonly apiBase = 'https://api.hetzner.cloud/v1';
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  // Boot (cloud-init, binary download, first start) normally takes 1-2 min.
  readonly readyTimeoutMs = 300_000;
  private readonly privateIpTimeoutMs = 60_000;
  private readonly pollMs = 5_000;
  private readonly healthTimeoutMs = 5_000;

  constructor(
    private readonly cfg: GatewayOrchestratorConfig,
    deps: GatewayOrchestratorDeps = {},
  ) {
    this.fetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /**
   * The orchestrator for gateway workers, or null when its env isn't set (no
   * gateway boxes are created then). A partial or invalid setup is logged as
   * an error and also yields null, so it never stops the API from booting.
   */
  static fromConfig(
    config: ConfigService,
    deps?: GatewayOrchestratorDeps,
  ): GatewayOrchestrator | null {
    const logger = new Logger(GatewayOrchestrator.name);
    const get = (key: string) => config.get<string>(key)?.trim() || undefined;
    const gatewayKeys = GATEWAY_REQUIRED_ENV.filter((k) => k !== 'HETZNER_API_TOKEN');
    if (!gatewayKeys.some((k) => get(k))) {
      logger.log('Gateway orchestrator not configured: gateway boxes are registered by hand only');
      return null;
    }
    const missing = GATEWAY_REQUIRED_ENV.filter((k) => !get(k));
    if (missing.length > 0) {
      logger.error(`Gateway orchestrator disabled: missing ${missing.join(', ')}`);
      return null;
    }
    try {
      return new GatewayOrchestrator(
        GatewayOrchestrator.parseConfig({
          token: get('HETZNER_API_TOKEN')!,
          networkId: get('GATEWAY_NETWORK_ID')!,
          firewallId: get('GATEWAY_FIREWALL_ID'),
          sshKeys: get('GATEWAY_SSH_KEYS'),
          serverType: get('GATEWAY_SERVER_TYPE') ?? 'cx23',
          location: get('GATEWAY_LOCATION') ?? 'fsn1',
          binaryUrl: get('GATEWAY_BINARY_URL')!,
          binarySha256: get('GATEWAY_BINARY_SHA256')!,
          dbUrl: get('GATEWAY_DB_URL')!,
          dbMaxConns: get('GATEWAY_DB_MAX_CONNS') ?? '4',
          webhookResolve: get('GATEWAY_WEBHOOK_RESOLVE'),
        }),
        deps,
      );
    } catch (error) {
      // The message names the variable, never its value.
      logger.error(
        `Gateway orchestrator disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Validates what ends up in the box's user-data (shell and env-file lines). */
  static parseConfig(raw: {
    token: string;
    networkId: string;
    firewallId?: string;
    sshKeys?: string;
    serverType: string;
    location: string;
    binaryUrl: string;
    binarySha256: string;
    dbUrl: string;
    dbMaxConns: string;
    webhookResolve?: string;
  }): GatewayOrchestratorConfig {
    const id = (name: string, v: string) => {
      if (!/^\d+$/.test(v)) throw new Error(`${name} must be a numeric Hetzner ID`);
      return Number(v);
    };
    // One token, no quotes, backslashes or whitespace: these go into a shell
    // script and a systemd EnvironmentFile verbatim.
    const plain = (name: string, v: string) => {
      if (!/^[^\s'"\\`]+$/.test(v)) {
        throw new Error(`${name} must not contain whitespace, quotes or backslashes`);
      }
      return v;
    };
    if (!/^https:\/\//.test(raw.binaryUrl)) {
      throw new Error('GATEWAY_BINARY_URL must be an https:// URL');
    }
    if (!/^[0-9a-f]{64}$/i.test(raw.binarySha256)) {
      throw new Error('GATEWAY_BINARY_SHA256 must be 64 hex characters');
    }
    if (!/^postgres(ql)?:\/\//.test(raw.dbUrl)) {
      throw new Error('GATEWAY_DB_URL must be a postgres:// DSN (the boxes share one store)');
    }
    const dbMaxConns = Number(raw.dbMaxConns);
    if (!Number.isInteger(dbMaxConns) || dbMaxConns < 1) {
      throw new Error('GATEWAY_DB_MAX_CONNS must be a positive integer');
    }
    return {
      token: raw.token,
      networkId: id('GATEWAY_NETWORK_ID', raw.networkId),
      firewallId: raw.firewallId ? id('GATEWAY_FIREWALL_ID', raw.firewallId) : undefined,
      sshKeys: (raw.sshKeys ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      serverType: plain('GATEWAY_SERVER_TYPE', raw.serverType),
      location: plain('GATEWAY_LOCATION', raw.location),
      binaryUrl: plain('GATEWAY_BINARY_URL', raw.binaryUrl),
      binarySha256: raw.binarySha256.toLowerCase(),
      dbUrl: plain('GATEWAY_DB_URL', raw.dbUrl),
      dbMaxConns,
      webhookResolve: raw.webhookResolve
        ? plain('GATEWAY_WEBHOOK_RESOLVE', raw.webhookResolve)
        : undefined,
    };
  }

  async provisionWorker(hooks?: ProvisionHooks): Promise<ProvisionResult> {
    await this.refuseWhileABoxIsDown();

    const name = `wagw-${crypto.randomBytes(4).toString('hex')}`;
    const apiKey = crypto.randomBytes(32).toString('hex');
    const userData = buildGatewayUserData({
      name,
      apiKey,
      networkId: this.cfg.networkId,
      binaryUrl: this.cfg.binaryUrl,
      binarySha256: this.cfg.binarySha256,
      dbUrl: this.cfg.dbUrl,
      dbMaxConns: this.cfg.dbMaxConns,
      webhookResolve: this.cfg.webhookResolve,
    });
    const startedAt = this.now();

    const { server } = await this.hetzner<{ server: HetznerServer }>('POST', '/servers', {
      name,
      server_type: this.cfg.serverType,
      location: this.cfg.location,
      image: 'ubuntu-24.04',
      networks: [this.cfg.networkId],
      ...(this.cfg.firewallId ? { firewalls: [{ firewall: this.cfg.firewallId }] } : {}),
      ...(this.cfg.sshKeys.length > 0 ? { ssh_keys: this.cfg.sshKeys } : {}),
      labels: { [GATEWAY_LABEL.key]: GATEWAY_LABEL.value },
      // IPv4 for webhooks to the API (its name has no AAAA record); the /64 for WhatsApp.
      public_net: { enable_ipv4: true, enable_ipv6: true },
      start_after_create: true,
      user_data: userData,
    });
    this.logger.log(`Created gateway box ${name} (server ${server.id}) — waiting for its private address`);

    let internalIp: string;
    try {
      internalIp = this.privateIp(server) ?? (await this.waitForPrivateIp(server.id));
      await hooks?.onCreated?.({ podName: name, internalIp, apiKey });
    } catch (error) {
      // Nothing knows this box's key yet: remove it rather than leave it unusable.
      this.logger.error(
        `Gateway box ${name} can't be registered (${error instanceof Error ? error.message : String(error)}) — deleting it`,
      );
      await this.deleteServer(server.id).catch((e: unknown) =>
        this.logger.error(
          `Deleting gateway box ${name} failed: ${e instanceof Error ? e.message : String(e)} — delete it by hand`,
        ),
      );
      throw error;
    }

    const deadline = startedAt + this.readyTimeoutMs;
    while (this.now() < deadline) {
      if (await this.isHealthy(internalIp)) {
        this.logger.log(`Gateway box ${name} is healthy at ${internalIp}`);
        return { podName: name, internalIp, apiKey };
      }
      await this.sleep(this.pollMs);
    }
    // Left running: a slow box is registered by the next scaling check once it
    // answers, and a broken one blocks further boxes until someone looks at it.
    throw new Error(
      `Gateway box ${name} (${internalIp}) did not answer /health within ${this.readyTimeoutMs / 1000}s — left running for inspection`,
    );
  }

  /**
   * One box that doesn't answer /health (still booting, or broken) stops
   * another from being created: a bad binary or setup can't multiply, and a
   * box that is merely slow is picked up by the next scaling check.
   */
  private async refuseWhileABoxIsDown(): Promise<void> {
    // A labelled box off the API's network isn't one of ours unless it is
    // still being created (the network attaches during creation).
    const boxes = (await this.listBoxes()).filter(
      (b) => this.privateIp(b) || this.now() - new Date(b.created).getTime() < 10 * 60_000,
    );
    const health = await Promise.all(
      boxes.map(async (box) => {
        const ip = this.privateIp(box);
        return ip ? this.isHealthy(ip) : false;
      }),
    );
    const down = boxes.find((_, i) => !health[i]);
    if (!down) return;
    const ageMin = Math.round((this.now() - new Date(down.created).getTime()) / 60_000);
    throw new Error(
      `Gateway box ${down.name} (created ${ageMin} min ago, ${down.status}) doesn't answer /health — ` +
        'not creating another until it does or it is deleted',
    );
  }

  async destroyWorker(podName: string): Promise<boolean> {
    const box = await this.findBox(podName);
    if (!box) {
      // A row registered by hand may name a box differently: never guess.
      this.logger.warn(`No gateway box named ${podName} — keeping the worker; delete the box by hand`);
      return false;
    }
    await this.deleteServer(box.id);
    this.logger.log(`Deleted gateway box ${podName} (server ${box.id})`);
    return true;
  }

  async getWorkerStatus(podName: string): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      const box = await this.findBox(podName);
      if (!box) return 'unknown';
      if (box.status === 'running') return 'running';
      if (box.status === 'off' || box.status === 'stopping' || box.status === 'deleting') return 'stopped';
      return 'unknown';
    } catch (error) {
      this.logger.warn(
        `Gateway box ${podName} status unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'unknown';
    }
  }

  /**
   * Every gateway box on the API's network that answers /health. The key is
   * '' — the worker row holds it (written by onCreated when the box was made).
   */
  async listReadyWorkers(): Promise<ProvisionResult[]> {
    const boxes = (await this.listBoxes()).filter((b) => this.privateIp(b));
    const healthy = await Promise.all(boxes.map((b) => this.isHealthy(this.privateIp(b)!)));
    return boxes
      .filter((_, i) => healthy[i])
      .map((b) => ({ podName: b.name, internalIp: this.privateIp(b)!, apiKey: '' }));
  }

  private privateIp(server: HetznerServer): string | undefined {
    return server.private_net?.find((n) => n.network === this.cfg.networkId)?.ip || undefined;
  }

  private async waitForPrivateIp(serverId: number): Promise<string> {
    const deadline = this.now() + this.privateIpTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(2_000);
      const { server } = await this.hetzner<{ server: HetznerServer }>('GET', `/servers/${serverId}`);
      const ip = this.privateIp(server);
      if (ip) return ip;
    }
    throw new Error(
      `server ${serverId} got no address on network ${this.cfg.networkId} within ${this.privateIpTimeoutMs / 1000}s`,
    );
  }

  private async isHealthy(ip: string): Promise<boolean> {
    try {
      const res = await this.fetch(`http://${ip}:3000/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body?.status === 'ok';
    } catch {
      return false;
    }
  }

  private async listBoxes(): Promise<HetznerServer[]> {
    const selector = encodeURIComponent(`${GATEWAY_LABEL.key}=${GATEWAY_LABEL.value}`);
    const boxes: HetznerServer[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.hetzner<{
        servers: HetznerServer[];
        meta?: { pagination?: { next_page: number | null } };
      }>('GET', `/servers?label_selector=${selector}&per_page=50&page=${page}`);
      boxes.push(...res.servers);
      if (!res.meta?.pagination?.next_page) break;
    }
    return boxes;
  }

  private async findBox(name: string): Promise<HetznerServer | undefined> {
    const { servers } = await this.hetzner<{ servers: HetznerServer[] }>(
      'GET',
      `/servers?name=${encodeURIComponent(name)}`,
    );
    return servers.find((s) => s.name === name);
  }

  private async deleteServer(id: number): Promise<void> {
    await this.hetzner('DELETE', `/servers/${id}`);
  }

  private async hetzner<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? detail;
      } catch {
        // not JSON
      }
      throw new Error(`Hetzner ${method} ${path.split('?')[0]} failed (${res.status}): ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
