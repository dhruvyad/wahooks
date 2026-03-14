import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { users, apiTokens } from '@wahooks/db';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_TOKEN } from '../database/database.module';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwksClient: jwksRsa.JwksClient;

  constructor(
    private readonly configService: ConfigService,
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
  ) {
    const supabaseUrl = this.configService.getOrThrow<string>('SUPABASE_URL');
    const jwksUri = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;

    this.jwksClient = jwksRsa({
      jwksUri,
      cache: true,
      cacheMaxAge: 600_000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.slice(7);

    // API token path: tokens starting with "wh_"
    if (token.startsWith('wh_')) {
      return this.verifyApiToken(request, token);
    }

    // JWT path: Supabase JWT
    const payload = await this.verifyJwt(token);

    // Upsert user into the users table so FK constraints are satisfied
    const userId = payload.sub as string;
    const email = payload.email as string;
    if (userId && email) {
      try {
        await this.db
          .insert(users)
          .values({ id: userId, email })
          .onConflictDoUpdate({
            target: users.id,
            set: { email, updatedAt: sql`now()` },
          });
      } catch (error) {
        this.logger.error(
          `Failed to upsert user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    request.user = payload;
    return true;
  }

  private async verifyApiToken(
    request: any,
    token: string,
  ): Promise<boolean> {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const [apiToken] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash));

    if (!apiToken || !apiToken.active) {
      throw new UnauthorizedException('Invalid or revoked API token');
    }

    // Update last used timestamp (fire and forget)
    this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, apiToken.id))
      .catch(() => {});

    request.user = { sub: apiToken.userId };
    return true;
  }

  private async verifyJwt(token: string): Promise<Record<string, unknown>> {
    // Decode header to get kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw new UnauthorizedException('Invalid token format');
    }

    const kid = decoded.header.kid;
    if (!kid) {
      throw new UnauthorizedException('Token missing key ID (kid)');
    }

    // Fetch the signing key from JWKS endpoint
    let signingKey: string;
    try {
      const key = await this.jwksClient.getSigningKey(kid);
      signingKey = key.getPublicKey();
    } catch (error) {
      this.logger.error(
        `Failed to get signing key: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Unable to verify token signing key');
    }

    // Verify the token
    try {
      const payload = jwt.verify(token, signingKey, {
        algorithms: ['RS256', 'ES256'],
      });
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException('Token has expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException('Invalid token signature');
      }
      throw new UnauthorizedException('Token verification failed');
    }
  }
}
