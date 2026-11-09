import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { loadYaml } from '@kubernetes/client-node';
import { GatewayOrchestrator, GATEWAY_REQUIRED_ENV } from './gateway.orchestrator';
import { WAGW_SERVICE, buildGatewayUserData, staticEnvLines } from './gateway-cloud-init';

// Obvious test values only: nothing here is a real token, key or address.
const ENV: Record<string, string> = {
  HETZNER_API_TOKEN: 'test-hcloud-token',
  GATEWAY_NETWORK_ID: '4242',
  GATEWAY_FIREWALL_ID: '77',
  GATEWAY_SSH_KEYS: 'ops-key, backup-key',
  GATEWAY_BINARY_URL: 'https://downloads.example.com/wagw/gateway-linux-amd64',
  GATEWAY_BINARY_SHA256: 'ab'.repeat(32),
  GATEWAY_DB_URL: 'postgres://wagw:test-password@db.example.com:5432/postgres?search_path=wagw&sslmode=require',
};

const NETWORK = 4242;

type Box = { id: number; name: string; status: string; created: string; private_net: Array<{ network: number; ip: string }> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fake Hetzner API plus the boxes' /health, on a clock that sleep() advances. */
function cloud() {
  const state = {
    clock: 1_000_000,
    boxes: [] as Box[],
    healthy: new Set<string>(),
    created: [] as any[],
    deleted: [] as number[],
    // How many GET /servers/{id} polls before the private address shows up.
    ipAfterPolls: 0,
    // Health checks a new box fails before it answers ok.
    bootChecks: 2,
    calls: [] as Array<{ method: string; url: string; auth?: string }>,
  };
  const fetch = jest.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    state.calls.push({ method, url, auth });

    const health = url.match(/^http:\/\/([\d.]+):3000\/health$/);
    if (health) {
      const ip = health[1];
      if (!state.healthy.has(ip)) {
        const box = state.boxes.find((b) => b.private_net.some((n) => n.ip === ip));
        if (box && state.bootChecks-- <= 0) state.healthy.add(ip);
        throw new Error('connect ECONNREFUSED');
      }
      return json({ status: 'ok', sessions: {}, uptimeSeconds: 5 });
    }

    const api = url.replace('https://api.hetzner.cloud/v1', '');
    if (method === 'GET' && api.startsWith('/servers?label_selector=role%3Dwagw')) {
      return json({ servers: state.boxes, meta: { pagination: { next_page: null } } });
    }
    if (method === 'GET' && api.startsWith('/servers?name=')) {
      const name = decodeURIComponent(api.split('=')[1]);
      return json({ servers: state.boxes.filter((b) => b.name === name) });
    }
    if (method === 'POST' && api === '/servers') {
      const body = JSON.parse(String(init!.body));
      state.created.push(body);
      const box: Box = {
        id: 900 + state.created.length,
        name: body.name,
        status: 'initializing',
        created: new Date(state.clock).toISOString(),
        private_net: [],
      };
      state.boxes.push(box);
      return json({ server: box, root_password: null }, 201);
    }
    const byId = api.match(/^\/servers\/(\d+)$/);
    if (byId && method === 'GET') {
      const box = state.boxes.find((b) => b.id === Number(byId[1]))!;
      if (state.ipAfterPolls-- <= 0 && box.private_net.length === 0) {
        box.private_net = [{ network: NETWORK, ip: `10.0.1.${box.id - 890}` }];
        box.status = 'running';
      }
      return json({ server: box });
    }
    if (byId && method === 'DELETE') {
      state.deleted.push(Number(byId[1]));
      state.boxes = state.boxes.filter((b) => b.id !== Number(byId[1]));
      return json({ action: { id: 1 } });
    }
    return json({ error: { code: 'not_found', message: `no route ${method} ${api}` } }, 404);
  });
  const deps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => state.clock,
    sleep: async (ms: number) => {
      state.clock += ms;
    },
  };
  return { state, fetch, deps };
}

function configFrom(env: Record<string, string>) {
  return { get: (key: string) => env[key] } as any;
}

function quiet(orchestrator: GatewayOrchestrator) {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn((orchestrator as any).logger, level).mockImplementation(() => undefined);
  }
  return orchestrator;
}

describe('GatewayOrchestrator', () => {
  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('fromConfig', () => {
    it('is off (null) when no gateway env is set', () => {
      expect(GatewayOrchestrator.fromConfig(configFrom({ HETZNER_API_TOKEN: 'test-hcloud-token' }))).toBeNull();
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('is off, naming what is missing (never a value), when the env is partial', () => {
      const { GATEWAY_DB_URL: _db, HETZNER_API_TOKEN: _token, ...partial } = ENV;
      expect(GatewayOrchestrator.fromConfig(configFrom(partial))).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('missing HETZNER_API_TOKEN, GATEWAY_DB_URL'));
    });

    it('refuses values that would break the box setup', () => {
      expect(GatewayOrchestrator.fromConfig(configFrom({ ...ENV, GATEWAY_BINARY_SHA256: 'abc' }))).toBeNull();
      expect(GatewayOrchestrator.fromConfig(configFrom({ ...ENV, GATEWAY_DB_URL: "postgres://x/y?a='1'" }))).toBeNull();
      expect(GatewayOrchestrator.fromConfig(configFrom({ ...ENV, GATEWAY_NETWORK_ID: 'wahooks' }))).toBeNull();
      expect(GatewayOrchestrator.fromConfig(configFrom({ ...ENV, GATEWAY_BINARY_URL: 'http://plain.example.com/gw' }))).toBeNull();
      for (const [message] of errorLog.mock.calls) {
        expect(message).not.toContain('test-password');
      }
    });

    it('is on with every required variable', () => {
      expect(GATEWAY_REQUIRED_ENV).toEqual([
        'HETZNER_API_TOKEN', 'GATEWAY_NETWORK_ID', 'GATEWAY_BINARY_URL', 'GATEWAY_BINARY_SHA256', 'GATEWAY_DB_URL',
      ]);
      expect(GatewayOrchestrator.fromConfig(configFrom(ENV))).toBeInstanceOf(GatewayOrchestrator);
    });
  });

  describe('provisionWorker', () => {
    it('creates a labelled Ubuntu box on the private network and returns it once /health answers', async () => {
      const { state, deps } = cloud();
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);
      const onCreated = jest.fn(async () => {
        // The key is persisted before the box is healthy.
        expect(state.healthy.size).toBe(0);
      });

      const result = await orchestrator.provisionWorker({ onCreated });

      expect(state.created).toHaveLength(1);
      const body = state.created[0];
      expect(body).toMatchObject({
        server_type: 'cx23',
        location: 'fsn1',
        image: 'ubuntu-24.04',
        networks: [NETWORK],
        firewalls: [{ firewall: 77 }],
        ssh_keys: ['ops-key', 'backup-key'],
        labels: { role: 'wagw' },
        public_net: { enable_ipv4: true, enable_ipv6: true },
      });
      expect(body.name).toMatch(/^wagw-[0-9a-f]{8}$/);
      expect(result).toEqual({ podName: body.name, internalIp: '10.0.1.11', apiKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(onCreated).toHaveBeenCalledWith(result);
      // Every Hetzner call carries the token; nothing else does.
      for (const call of state.calls) {
        expect(call.auth).toBe(call.url.startsWith('https://api.hetzner.cloud/') ? 'Bearer test-hcloud-token' : undefined);
      }
    });

    it("writes the box's wagw.env: the API's key, the store, the box id; address, /64 and GOMEMLIMIT found at boot", async () => {
      const { state, deps } = cloud();
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom({ ...ENV, GATEWAY_DB_MAX_CONNS: '6' }), deps)!);

      const { podName, apiKey } = await orchestrator.provisionWorker();
      const userData: string = state.created[0].user_data;

      expect(userData.startsWith('#cloud-config\n')).toBe(true);
      const doc = loadYaml<any>(userData);
      const files = Object.fromEntries(doc.write_files.map((f: any) => [f.path, f]));
      expect(doc.runcmd).toEqual([['/root/wagw-bootstrap/setup.sh']]);

      // wagw.service exactly as gateway/deploy ships it.
      expect(files['/etc/systemd/system/wagw.service'].content).toBe(WAGW_SERVICE);

      // Known before boot (root-only until setup.sh merges it into wagw.env).
      expect(files['/root/wagw-bootstrap/wagw.env.static'].permissions).toBe('0600');
      expect(files['/root/wagw-bootstrap/wagw.env.static'].content.split('\n')).toEqual(
        expect.arrayContaining([
          `WAGW_API_KEY=${apiKey}`,
          `WAGW_DB=${ENV.GATEWAY_DB_URL}`,
          'WAGW_DB_MAX_CONNS=6',
          `WAGW_BOX_ID=${podName}`,
          'WAGW_MEDIA_DIR=/var/lib/wagw/media',
        ]),
      );

      // Found at boot, then wagw.env is written 0640 root:wagw.
      const setup: string = files['/root/wagw-bootstrap/setup.sh'].content;
      expect(setup).toContain("NETWORK_ID='4242'");
      expect(setup).toContain(`BINARY_URL='${ENV.GATEWAY_BINARY_URL}'`);
      expect(setup).toContain(`BINARY_SHA256='${'ab'.repeat(32)}'`);
      expect(setup).toContain('sha256sum -c --quiet -');
      expect(setup).toContain('echo "WAGW_LISTEN=$ip4:3000"');
      expect(setup).toContain('echo "WAGW_IPV6_PREFIX=$prefix"');
      expect(setup).toContain('echo "GOMEMLIMIT=$((mem_kb * 78 / 100 / 1024))MiB"');
      expect(setup).toContain('chown root:wagw /etc/wagw/wagw.env.new');
      expect(setup).toContain('chmod 0640 /etc/wagw/wagw.env.new');
      expect(setup).toContain('mv -f /etc/wagw/wagw.env.new /etc/wagw/wagw.env');
      expect(setup).toContain('systemctl enable -q --now wagw');
      const addrs: string = files['/root/wagw-bootstrap/addrs.py'].content;
      expect(addrs).toContain('http://169.254.169.254/hetzner/v1/metadata');
      expect(addrs).toContain('/private-networks');
    });

    it('waits for the private address when the create response has none yet', async () => {
      const { state, deps } = cloud();
      state.ipAfterPolls = 3;
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.provisionWorker()).resolves.toMatchObject({ internalIp: '10.0.1.11' });
      expect(state.calls.filter((c) => c.method === 'GET' && /\/servers\/\d+$/.test(c.url))).toHaveLength(4);
    });

    it('leaves a box that never answers running for inspection and says so after ~5 min', async () => {
      const { state, deps } = cloud();
      state.bootChecks = Infinity;
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.provisionWorker()).rejects.toThrow(/did not answer \/health within 300s/);
      expect(state.deleted).toEqual([]);
      expect(state.clock - 1_000_000).toBeGreaterThanOrEqual(300_000);
    });

    it('deletes the box when its key cannot be recorded, so no box exists that nothing can reach', async () => {
      const { state, deps } = cloud();
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(
        orchestrator.provisionWorker({ onCreated: async () => { throw new Error('database down'); } }),
      ).rejects.toThrow('database down');
      expect(state.deleted).toEqual([901]);
    });

    it('creates nothing while another gateway box does not answer /health', async () => {
      const { state, deps } = cloud();
      state.boxes.push({
        id: 500, name: 'wagw-deadbeef', status: 'running',
        created: new Date(state.clock - 40 * 60_000).toISOString(),
        private_net: [{ network: NETWORK, ip: '10.0.1.50' }],
      });
      state.bootChecks = Infinity;
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.provisionWorker()).rejects.toThrow(/wagw-deadbeef \(created 40 min ago, running\) doesn't answer \/health/);
      expect(state.created).toHaveLength(0);
    });

    it("ignores a labelled box that isn't on the API's network", async () => {
      const { state, deps } = cloud();
      state.boxes.push({
        id: 501, name: 'relay-box', status: 'running',
        created: new Date(state.clock - 24 * 60 * 60_000).toISOString(), private_net: [],
      });
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.provisionWorker()).resolves.toMatchObject({ internalIp: '10.0.1.11' });
    });
  });

  describe('listReadyWorkers', () => {
    it('returns the healthy boxes on the network, with no key (the worker row has it)', async () => {
      const { state, deps } = cloud();
      const net = (ip: string) => [{ network: NETWORK, ip }];
      const created = new Date(state.clock).toISOString();
      state.boxes.push(
        { id: 1, name: 'wagw-up', status: 'running', created, private_net: net('10.0.1.1') },
        { id: 2, name: 'wagw-down', status: 'running', created, private_net: net('10.0.1.2') },
        { id: 3, name: 'elsewhere', status: 'running', created, private_net: [{ network: 99, ip: '10.9.0.3' }] },
      );
      state.healthy.add('10.0.1.1');
      state.bootChecks = Infinity;
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.listReadyWorkers()).resolves.toEqual([
        { podName: 'wagw-up', internalIp: '10.0.1.1', apiKey: '' },
      ]);
    });
  });

  describe('destroyWorker / getWorkerStatus', () => {
    it('deletes the box with that name', async () => {
      const { state, deps } = cloud();
      state.boxes.push({ id: 7, name: 'wagw-0007', status: 'running', created: '', private_net: [] });
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.getWorkerStatus('wagw-0007')).resolves.toBe('running');
      await expect(orchestrator.destroyWorker('wagw-0007')).resolves.toBe(true);
      expect(state.deleted).toEqual([7]);
    });

    it('keeps a worker whose box it cannot find by name (a hand-registered row) instead of guessing', async () => {
      const { state, deps } = cloud();
      const orchestrator = quiet(GatewayOrchestrator.fromConfig(configFrom(ENV), deps)!);

      await expect(orchestrator.destroyWorker('wagw-a')).resolves.toBe(false);
      await expect(orchestrator.getWorkerStatus('wagw-a')).resolves.toBe('unknown');
      expect(state.deleted).toEqual([]);
    });
  });

  describe('cloud-init', () => {
    it('embeds gateway/deploy/wagw.service verbatim', () => {
      const file = path.join(__dirname, '..', '..', '..', '..', 'gateway', 'deploy', 'wagw.service');
      expect(WAGW_SERVICE).toBe(fs.readFileSync(file, 'utf8'));
    });

    it('passes WAGW_WEBHOOK_RESOLVE through only when set', () => {
      const spec = {
        name: 'wagw-00000000', apiKey: 'k', networkId: 1, binaryUrl: 'https://x/y',
        binarySha256: 'ab'.repeat(32), dbUrl: 'postgres://x', dbMaxConns: 4,
      };
      expect(staticEnvLines(spec).some((l) => l.startsWith('WAGW_WEBHOOK_RESOLVE='))).toBe(false);
      expect(staticEnvLines({ ...spec, webhookResolve: 'api.example.com:443:[2001:db8::1]' })).toContain(
        'WAGW_WEBHOOK_RESOLVE=api.example.com:443:[2001:db8::1]',
      );
      expect(() => loadYaml(buildGatewayUserData(spec))).not.toThrow();
    });
  });
});
