/**
 * Programmatic migration runner for CI/CD and production deployments.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm db:migrate:run
 *
 * To generate an initial migration from the current schema:
 *   DATABASE_URL=postgres://... pnpm db:generate
 *
 * Then apply it:
 *   DATABASE_URL=postgres://... pnpm db:migrate:run
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  console.log('Running migrations...');

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder: './drizzle' });

  console.log('Migrations complete');
  await sql.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
