#!/usr/bin/env bun
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';

import { poolFromEnv } from './_pool';

/**
 * Apply all pending migrations forward. Idempotent: already-applied versions
 * are skipped. Usage: `bun run db:migrate`.
 */
async function main(): Promise<void> {
  const pool = poolFromEnv();
  try {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    const result = await migrate(pool, migrations, { direction: 'up' });
    if (result.applied.length === 0) {
      console.log('migrate: already up to date');
    } else {
      console.log(`migrate: applied ${result.applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

await main();
