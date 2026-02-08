import { Injectable, Logger } from '@nestjs/common';
import { WahaSessionResponse, WahaQrCodeResponse } from './waha.types';

@Injectable()
export class WahaService {
  private readonly logger = new Logger(WahaService.name);

  private buildUrl(workerUrl: string, path: string): string {
    return `http://${workerUrl}:3000${path}`;
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const responseBody = await response.text();
        const message = `WAHA API error: ${method} ${url} returned ${response.status} - ${responseBody}`;
        this.logger.error(message);
        throw new Error(message);
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const message = `WAHA API timeout: ${method} ${url} exceeded 30s`;
        this.logger.error(message);
        throw new Error(message);
      }

      if (error instanceof Error && error.message.startsWith('WAHA API')) {
        throw error;
      }

      this.logger.error(
        `WAHA API request failed: ${method} ${url} - ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(workerUrl, '/api/sessions');
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Creating session "${sessionName}" on worker ${workerUrl}`);

    return this.request<WahaSessionResponse>('POST', url, headers, {
      name: sessionName,
      config: {
        webhooks: [],
      },
    });
  }

  async startSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/start`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Starting session "${sessionName}" on worker ${workerUrl}`);

    await this.request<void>('POST', url, headers);
  }

  async stopSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/stop`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Stopping session "${sessionName}" on worker ${workerUrl}`);

    await this.request<void>('POST', url, headers);
  }

  async getSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaSessionResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Getting session "${sessionName}" from worker ${workerUrl}`,
    );

    return this.request<WahaSessionResponse>('GET', url, headers);
  }

  async listSessions(
    workerUrl: string,
    apiKey: string,
  ): Promise<WahaSessionResponse[]> {
    const url = this.buildUrl(workerUrl, '/api/sessions?all=true');
    const headers = this.buildHeaders(apiKey);

    this.logger.log(`Listing sessions on worker ${workerUrl}`);

    return this.request<WahaSessionResponse[]>('GET', url, headers);
  }

  async getQrCode(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<WahaQrCodeResponse> {
    const url = this.buildUrl(
      workerUrl,
      `/api/${encodeURIComponent(sessionName)}/auth/qr`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Getting QR code for session "${sessionName}" on worker ${workerUrl}`,
    );

    return this.request<WahaQrCodeResponse>('GET', url, headers);
  }

  async restartSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/restart`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Restarting session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('POST', url, headers);
  }

  async logoutSession(
    workerUrl: string,
    apiKey: string,
    sessionName: string,
  ): Promise<void> {
    const url = this.buildUrl(
      workerUrl,
      `/api/sessions/${encodeURIComponent(sessionName)}/logout`,
    );
    const headers = this.buildHeaders(apiKey);

    this.logger.log(
      `Logging out session "${sessionName}" on worker ${workerUrl}`,
    );

    await this.request<void>('POST', url, headers);
  }
}
