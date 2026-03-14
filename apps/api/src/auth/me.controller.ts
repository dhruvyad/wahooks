import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { users } from '@wahooks/db';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './user.decorator';
import { DRIZZLE_TOKEN } from '../database/database.module';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(@Inject(DRIZZLE_TOKEN) private readonly db: any) {}

  @Get()
  async getMe(@CurrentUser() user: { sub: string }) {
    const [dbUser] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isAdmin: users.isAdmin,
      })
      .from(users)
      .where(eq(users.id, user.sub));

    if (!dbUser) {
      return { id: user.sub, isAdmin: false };
    }

    return dbUser;
  }
}
