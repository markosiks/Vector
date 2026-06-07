#!/usr/bin/env bun
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';
import { seedSmoke } from '@/lib/db/seed';
import type { Queryable } from '@/lib/db/types';

import { assertDestructiveAllowed, poolFromEnv } from './_pool';

/**
 * Idempotent full reset: roll every migration down, re-apply all forward, then
 * re-seed the smoke rows. Running it twice yields the same clean state.
 * Destructive (drops all data). Usage: `bun run db:reset`.
 */
async function main(): Promise<void> {
  assertDestructiveAllowed('db:reset');
  const pool = poolFromEnv();
  try {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    await migrate(pool, migrations, { direction: 'down', to: '0' });
    await migrate(pool, migrations, { direction: 'up' });
    await seedSmoke(pool as unknown as Queryable);
    console.log('reset: schema rebuilt and re-seeded');
  } finally {
    await pool.end();
  }
}

await main();
