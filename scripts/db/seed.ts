#!/usr/bin/env bun
import { seedSmoke } from '@/lib/db/seed';
import type { Queryable } from '@/lib/db/types';

import { poolFromEnv } from './_pool';

/**
 * Idempotent smoke seed: one row per table. Usage: `bun run db:seed`.
 * Assumes the schema is already migrated (`bun run db:migrate`).
 */
async function main(): Promise<void> {
  const pool = poolFromEnv();
  try {
    await seedSmoke(pool as unknown as Queryable);
    console.log('seed: smoke rows ensured (one per table)');
  } finally {
    await pool.end();
  }
}

await main();
