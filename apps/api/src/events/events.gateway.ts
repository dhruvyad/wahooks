import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { wahaSessions, apiTokens } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';
import { createHash } from 'crypto';

type AuthenticatedSocket = WebSocket & {
  userId?: string;
  connectionIds?: Set<string>;
};

@WebSocketGateway({ path: '/ws' })
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: any;

  private readonly logger = new Logger(EventsGateway.name);

  /** userId → Set of connected sockets */
  private readonly clients = new Map<string, Set<AuthenticatedSocket>>();

  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  async handleConnection(client: AuthenticatedSocket, req: IncomingMessage) {
    try {
      // Extract token from query string: /ws?token=wh_...
      const url = new URL(req.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token');

      if (!token) {
        client.close(4001, 'Missing token');
        return;
      }

      // Authenticate: look up API token
      const userId = await this.authenticateToken(token);
      if (!userId) {
        client.close(4003, 'Invalid token');
        return;
      }

      client.userId = userId;

      // Get user's connection IDs for filtering events
      const sessions = await this.db
        .select({ id: wahaSessions.id })
        .from(wahaSessions)
        .where(eq(wahaSessions.userId, userId));
      client.connectionIds = new Set(sessions.map((s: { id: string }) => s.id));

      // Track client
      if (!this.clients.has(userId)) {
        this.clients.set(userId, new Set());
      }
      this.clients.get(userId)!.add(client);

      this.logger.log(`WebSocket connected: user ${userId} (${this.clients.get(userId)!.size} sockets)`);
    } catch (error) {
      this.logger.error(`WebSocket auth error: ${error}`);
      client.close(4000, 'Authentication failed');
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.userId) {
      const userClients = this.clients.get(client.userId);
      if (userClients) {
        userClients.delete(client);
        if (userClients.size === 0) {
          this.clients.delete(client.userId);
        }
      }
      this.logger.log(`WebSocket disconnected: user ${client.userId}`);
    }
  }

  /**
   * Broadcast an event to all connected clients who own the given session.
   * Called by EventsController when a WAHA event arrives.
   */
  broadcastEvent(sessionId: string, userId: string, event: unknown) {
    const userClients = this.clients.get(userId);
    if (!userClients || userClients.size === 0) return;

    const message = JSON.stringify(event);
    let sent = 0;

    for (const client of userClients) {
      if (client.readyState === 1 /* OPEN */ && client.connectionIds?.has(sessionId)) {
        client.send(message);
        sent++;
      }
    }

    if (sent > 0) {
      this.logger.debug(`Broadcast event to ${sent} client(s) for session ${sessionId}`);
    }
  }

  private async authenticateToken(token: string): Promise<string | null> {
    // Support both API tokens (wh_...) and JWT tokens
    if (token.startsWith('wh_')) {
      const hash = createHash('sha256').update(token).digest('hex');
      const [apiToken] = await this.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, hash));

      if (!apiToken || !apiToken.active) return null;

      // Update last used
      await this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, apiToken.id));

      return apiToken.userId;
    }

    // Fall back to Supabase JWT verification (basic decode)
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.exp && payload.exp < Date.now() / 1000) return null;
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
}
