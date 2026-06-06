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
