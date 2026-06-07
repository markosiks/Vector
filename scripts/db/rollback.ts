#!/usr/bin/env bun
import { loadMigrations, migrate, MIGRATIONS_DIR } from '@/lib/db/migrate';

import { assertDestructiveAllowed, poolFromEnv } from './_pool';

/**
 * Roll back migrations. Usage:
 *   bun run db:rollback           # revert the most recent migration
 *   bun run db:rollback 2         # revert the last 2 migrations
 *   bun run db:rollback --to 0001 # revert everything above version 0001
 *   bun run db:rollback --all     # revert every applied migration
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let opts: { direction: 'down'; to?: string; steps?: number } = { direction: 'down', steps: 1 };

  const toIdx = args.indexOf('--to');
  if (toIdx !== -1) {
    const to = args[toIdx + 1];
    if (to === undefined) throw new Error('--to requires a version argument');
    opts = { direction: 'down', to };
  } else if (args.includes('--all')) {
    opts = { direction: 'down', to: '0' };
  } else if (args[0] !== undefined) {
    const steps = Number(args[0]);
    if (!Number.isInteger(steps) || steps < 1) throw new Error(`invalid step count: ${args[0]}`);
    opts = { direction: 'down', steps };
  }

  // `--all` / `--to 0` rolls every migration down (DROP all tables): a full
  // teardown, guarded like `db:reset`. Bounded N-step / to-version rollbacks
  // are intentional, lower-blast-radius operations and stay unguarded.
  if (opts.to === '0') assertDestructiveAllowed('db:rollback --all');

  const pool = poolFromEnv();
  try {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    const result = await migrate(pool, migrations, opts);
    if (result.applied.length === 0) {
      console.log('rollback: nothing to revert');
    } else {
      console.log(`rollback: reverted ${result.applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

await main();
