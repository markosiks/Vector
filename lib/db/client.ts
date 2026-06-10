import 'server-only';

import { Pool } from '@neondatabase/serverless';

import { ENV } from '../config/env';
import type { DbState } from '../health';
import type { Queryable } from './types';

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
  if (pool === undefined) {
    const created = new Pool({
      connectionString: ENV.DATABASE_URL,
      // Bound the client-side connect queue. The pool is reachable from the
      // unauthenticated `/api/health` probe (`checkDb`), whose wall-clock race
      // gives up at `boundMs` but does not cancel the in-flight `connect()`.
      // Under a flood against a saturated/slow backend those pending `connect()`
      // promises would otherwise accumulate without limit. With a timeout an
      // un-serviceable connect rejects instead of queuing forever; `checkDb`
      // already degrades a thrown connect to `'down'`, so health stays bounded.
      connectionTimeoutMillis: 10_000,
    });
    // An idle pooled client can fail asynchronously when the backend drops the
    // connection — Neon closes idle connections aggressively. node-postgres
    // surfaces that as a pool `'error'` event; with no listener the EventEmitter
    // rethrows and takes down the whole process, turning a routine idle-conn
    // reset into an outage of a long-running server. Swallow it: the pool has
    // already retired the dead client, and the next `connect()` transparently
    // opens a fresh one. Log only `err.name` — the error object can carry the
    // connection string, which must never be logged.
    created.on('error', (err: Error) => {
      console.error(`[db] idle pool client error: ${err.name}`);
    });
    pool = created;
  }
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

/**
 * Inject a pre-built pool so a test can supply a fake Neon client. Test-only.
 *
 * The alternative — `mock.module('@neondatabase/serverless', …)` — is the wrong
 * tool here: Bun links static imports eagerly at load, so a top-level module mock
 * is process-wide and cannot be restored once the integration suites (which
 * `import { Pool }` for a real connection) are linked in the same `bun test`
 * process. Injecting through this seam keeps the fake scoped to the test that
 * sets it and leaves the real driver untouched. Pass `undefined` to clear
 * (equivalent to {@link resetPool}). Not for production request paths.
 */
export function setPoolForTest(p: Pool | undefined): void {
  pool = p;
}

/**
 * Run `fn` inside a single-connection transaction: `BEGIN`, the body, then
 * `COMMIT` — or `ROLLBACK` and rethrow if the body throws. The dedicated client
 * is always released. This is the write path for the mutating operator routes
 * (P2.4), where a state change and its audit row must commit atomically (a torn
 * write would leave the kill switch toggled with no audit trail, or vice versa).
 *
 * The body receives a {@link Queryable} bound to the transaction's connection;
 * pass it to repos so all their statements land on the same client. Do not use
 * the shared pool inside `fn` — those queries would run outside the transaction.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((): void => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Adapt a Neon `PoolClient` (or any object whose `query` signature is a superset
 * of {@link Queryable}) to the narrow {@link Queryable} interface without a
 * double-cast. This is the safe alternative to `client as unknown as Queryable`
 * used at call sites (R-04): the structural check is explicit and confined to
 * this one function, making the cast auditable in a single place.
 */
export function toQueryable(client: { query: Queryable['query'] }): Queryable {
  return client;
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
      // Bound the probe server-side, but scope the timeout to a transaction
      // (`set_config(..., is_local = true)`) so it is discarded on COMMIT and
      // never leaks onto the pooled connection. A session-level
      // `set_config(..., false)` would persist after `release()` and silently
      // cancel an unrelated later query that reuses this connection at `boundMs`.
      // `set_config` is parameterized (unlike `SET`, which cannot bind `$n`).
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(boundMs)]);
        await client.query('SELECT 1');
        await client.query('COMMIT');
        return 'up';
      } catch (err) {
        await client.query('ROLLBACK').catch((): void => undefined);
        throw err;
      }
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
