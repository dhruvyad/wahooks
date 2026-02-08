import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ContainerOrchestrator,
  ProvisionResult,
} from './orchestrator.interface';

@Injectable()
export class HetznerOrchestrator implements ContainerOrchestrator {
  private readonly logger = new Logger(HetznerOrchestrator.name);
  private readonly apiBase = 'https://api.hetzner.cloud/v1';
  private readonly token: string;
  private readonly networkId: string;
  private readonly serverType: string;
  private readonly location: string;
  private readonly databaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.token = this.configService.getOrThrow<string>('HETZNER_API_TOKEN');
    this.networkId =
      this.configService.getOrThrow<string>('HETZNER_NETWORK_ID');
    this.serverType =
      this.configService.get<string>('HETZNER_SERVER_TYPE') ?? 'cx22';
    this.location =
      this.configService.get<string>('HETZNER_LOCATION') ?? 'fsn1';
    this.databaseUrl =
      this.configService.getOrThrow<string>('DATABASE_URL');
  }

  async provisionWorker(): Promise<ProvisionResult> {
    const apiKey = crypto.randomBytes(32).toString('hex');
    const workerName = `waha-worker-${Date.now()}`;

    const userData = this.buildCloudInit(workerName, apiKey);

    const response = await fetch(`${this.apiBase}/servers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: workerName,
        server_type: this.serverType,
        image: 'docker-ce',
        location: this.location,
        networks: [Number(this.networkId)],
        user_data: userData,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        `Hetzner create server failed (${response.status}): ${body}`,
      );
      throw new HttpException(
        `Failed to provision worker: ${response.statusText}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const data = (await response.json()) as {
      server: {
        id: number;
        private_net: Array<{ ip: string }>;
      };
    };

    const serverId = String(data.server.id);
    const internalIp =
      data.server.private_net?.[0]?.ip ?? '0.0.0.0';

    this.logger.log(
      `Provisioned worker ${workerName} (server ${serverId}) at ${internalIp}`,
    );

    return {
      hetznerServerId: serverId,
      internalIp,
      apiKey,
    };
  }

  async destroyWorker(hetznerServerId: string): Promise<void> {
    const response = await fetch(
      `${this.apiBase}/servers/${hetznerServerId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        `Hetzner delete server ${hetznerServerId} failed (${response.status}): ${body}`,
      );
      throw new HttpException(
        `Failed to destroy worker ${hetznerServerId}: ${response.statusText}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.logger.log(`Destroyed worker (server ${hetznerServerId})`);
  }

  async getWorkerStatus(
    hetznerServerId: string,
  ): Promise<'running' | 'stopped' | 'unknown'> {
    const response = await fetch(
      `${this.apiBase}/servers/${hetznerServerId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!response.ok) {
      this.logger.warn(
        `Hetzner get server ${hetznerServerId} failed (${response.status})`,
      );
      return 'unknown';
    }

    const data = (await response.json()) as {
      server: { status: string };
    };

    const status = data.server.status;

    if (status === 'running') return 'running';
    if (status === 'off' || status === 'stopped') return 'stopped';

    return 'unknown';
  }

  private buildCloudInit(workerName: string, apiKey: string): string {
    return `#cloud-config
packages:
  - docker.io
runcmd:
  - systemctl enable docker
  - systemctl start docker
  - docker pull devlikeapro/waha-plus:latest
  - docker run -d --name waha --restart=always -p 3000:3000 -e WHATSAPP_DEFAULT_ENGINE=NOWEB -e WAHA_WORKER_ID=${workerName} -e WHATSAPP_API_KEY=${apiKey} -e WHATSAPP_SESSIONS_POSTGRESQL_URL=${this.databaseUrl} devlikeapro/waha-plus:latest
`;
  }
}
