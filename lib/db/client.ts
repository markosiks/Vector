import 'server-only';

import { Pool } from '@neondatabase/serverless';

import { ENV } from '../config/env';
import type { DbState } from '../health';

/**
 * Server-only Neon (Postgres) access.
 *
 * The connection string is read exclusively from the validated, server-only
 * {@link ENV}; it is never accepted from a request or hardcoded. The pool is a
 * process singleton so concurrent requests reuse connections.
 */

let pool: Pool | undefined;

/** Lazily create and return the shared Neon connection pool. */
export function getPool(): Pool {
  pool ??= new Pool({ connectionString: ENV.DATABASE_URL });
  return pool;
}

/** Default upper bound on the health probe before it reports `down`. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Probe the database with `SELECT 1`, bounded by `timeoutMs`.
 *
 * Returns `'up'` only on a successful round-trip. Every failure mode —
 * unreachable host, refused connection, TLS error, mid-query disconnect, or
 * timeout — collapses to `'down'`. It never throws and never logs the
 * connection string or any secret, so callers can treat the result as a total
 * function.
 */
export async function checkDb(timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<DbState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = getPool()
      .query('SELECT 1')
      .then((): DbState => 'up');

    const timeout = new Promise<DbState>((resolve) => {
      timer = setTimeout(() => resolve('down'), timeoutMs);
    });

    return await Promise.race([probe, timeout]);
  } catch {
    return 'down';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
