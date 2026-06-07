import { Pool } from '@neondatabase/serverless';

import { parseEnv } from '@/lib/config/env.schema';

/**
 * Build a Neon pool for CLI tooling from a validated `DATABASE_URL`.
 *
 * Scripts run outside the Next runtime, so they read and validate the env
 * directly with the side-effect-free `parseEnv` (which has no `server-only`
 * guard) rather than importing the server-only `ENV`/client modules.
 */
export function poolFromEnv(): Pool {
  const env = parseEnv(process.env);
  return new Pool({ connectionString: env.DATABASE_URL });
}

/**
 * Refuse a full-teardown destructive operation unless explicitly opted in.
 *
 * `db:reset` and a rollback-to-zero roll every migration *down*, i.e. `DROP`
 * every table — total, irreversible data loss. These scripts read whatever
 * `DATABASE_URL` is in the environment, so a connection string pointed at a real
 * database could be wiped by a single mistaken command with no confirmation.
 * Gate the teardown behind an explicit `VECTOR_ALLOW_DESTRUCTIVE=1` so it can
 * only happen on purpose. (Non-teardown operations — forward migrations, a
 * bounded N-step rollback — are unaffected.)
 */
export function assertDestructiveAllowed(action: string): void {
  if (process.env.VECTOR_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error(
      `${action} is destructive (drops all data) and is disabled by default. ` +
        'Set VECTOR_ALLOW_DESTRUCTIVE=1 to confirm you are targeting the intended database.',
    );
  }
}
