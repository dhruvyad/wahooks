import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@wahooks/db';

export const DRIZZLE_TOKEN = 'DATABASE';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_TOKEN,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.getOrThrow<string>('DATABASE_URL');
        const client = postgres(databaseUrl, {
          max: 5,              // limit pool size (free tier has ~60 total)
          idle_timeout: 20,    // close idle connections after 20s
          connect_timeout: 10, // fail fast on connection issues
        });
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DRIZZLE_TOKEN],
})
export class DatabaseModule {}
