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

/**
 * Drop the cached pool so the next {@link getPool} rebuilds it. Test-only:
 * because the pool is a process singleton, a test that primes it — with the
 * real driver, or after `getPool().end()` — would otherwise leave a stale pool
 * that later tests in the same process reuse, defeating their driver mocks.
 * Closing the underlying connections stays the creator's responsibility; this
 * only clears the cache. Not for production request paths.
 */
export function resetPool(): void {
  pool = undefined;
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
 *
 * The probe runs on its own pooled client which is **always** released, and the
 * query is bounded server-side by `statement_timeout`. Without that bound the
 * wall-clock race below would report `'down'` while the underlying `SELECT 1`
 * kept holding its connection until an OS-level TCP timeout — so a slow/hung
 * backend, hit repeatedly through the unauthenticated `/api/health` endpoint,
 * could pin every connection in the shared pool and turn a transient DB blip
 * into a process-wide outage.
 */
export async function checkDb(timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<DbState> {
  const boundMs = Math.max(1, Math.trunc(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<DbState>((resolve) => {
    timer = setTimeout(() => resolve('down'), boundMs);
  });

  const probe: Promise<DbState> = (async (): Promise<DbState> => {
    const client = await getPool().connect();
    try {
      await client.query("SELECT set_config('statement_timeout', $1, false)", [String(boundMs)]);
      await client.query('SELECT 1');
      return 'up';
    } finally {
      client.release();
    }
  })().catch((): DbState => 'down');

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
