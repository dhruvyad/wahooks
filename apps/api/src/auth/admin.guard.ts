import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { users } from '@wahooks/db';
import { DRIZZLE_TOKEN } from '../database/database.module';

export const ADMIN_ONLY_KEY = 'adminOnly';

/**
 * Decorator: marks a route as admin-only.
 * Usage: @AdminOnly() on a controller method or class.
 */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

/**
 * Guard: checks if the authenticated user has is_admin=true in the DB.
 * Must be used AFTER AuthGuard (requires request.user to be set).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isAdminOnly = this.reflector.getAllAndOverride<boolean>(
      ADMIN_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!isAdminOnly) return true;

    const request = context.switchToHttp().getRequest();
    const userId = request.user?.sub;

    if (!userId) {
      throw new ForbiddenException('Authentication required');
    }

    const [user] = await this.db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId));

    if (!user?.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
