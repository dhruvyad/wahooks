import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwksClient: jwksRsa.JwksClient;

  constructor(private readonly configService: ConfigService) {
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
    const payload = await this.verifyJwt(token);

    request.user = payload;
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
