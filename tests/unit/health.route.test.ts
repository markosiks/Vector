import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';

import type { Pool } from '@neondatabase/serverless';

import type { DbState, HealthPayload } from '@/lib/health';

/**
 * Tests the `/api/health` route handler end-to-end in-process. Only `server-only`
 * (a no-op outside Next) is mocked; the Neon round-trip is faked by injecting a
 * pool through the db client's `setPoolForTest` seam — never by mocking the
 * `@neondatabase/serverless` module, since Bun links static imports eagerly and a
 * process-wide driver mock would poison the real-Neon integration suites in a
 * one-process `bun test`. The idle-error test exercises the *real* driver so it
 * can assert the pool's construction-time wiring. The route + db-client +
 * health-formatter wiring is exercised for real, without a server or live DB.
 */

// Controls what the fake pool's `SELECT 1` does, per test.
let queryBehavior: () => Promise<unknown> = async () => ({ rows: [{ result: 1 }] });

// Every query the probe issues, in order (for asserting the transaction shape).
const recorded: { sql: string; params?: readonly unknown[] | undefined }[] = [];

// A valid DB string so eager env validation passes when the route imports env.
// `??=`: never clobber a real `DATABASE_URL` — this file injects a fake pool (its
// only real-driver use, the idle-error test, is connectionless), so overwriting
// would freeze the process-wide `ENV.DATABASE_URL` to a fake and break the
// real-Neon integration probes in a one-process `bun test`. Restored in `afterAll`
// so a fake we *did* set can't un-skip the integration suites.
const prevDbUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= 'postgresql://user:pass@host.neon.tech/db?sslmode=require';

/**
 * A fake pool injected through `setPoolForTest`: routes only `SELECT 1` through
 * `queryBehavior` so a test can make the probe fail or hang while BEGIN/COMMIT/
 * ROLLBACK still resolve, and records each query for asserting the probe's shape.
 */
class MockPool {
  async connect(): Promise<{
    query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
    release: () => void;
  }> {
    return {
      query: (sql: string, params?: readonly unknown[]): Promise<unknown> => {
        recorded.push({ sql, params });
        return sql === 'SELECT 1' ? queryBehavior() : Promise.resolve({ rows: [] });
      },
      release: (): void => undefined,
    };
  }
}

mock.module('server-only', () => ({}));

let GET: () => Promise<Response>;
let resetPool: () => void;
let setPoolForTest: (p: Pool | undefined) => void;
let getPool: () => Pool;
let checkDb: (timeoutMs?: number) => Promise<DbState>;

beforeAll(async () => {
  const client = await import('@/lib/db/client');
  resetPool = client.resetPool;
  setPoolForTest = client.setPoolForTest;
  getPool = client.getPool;
  checkDb = client.checkDb;
  resetPool();
  setPoolForTest(new MockPool() as unknown as Pool); // probe/route `getPool()` → this fake
  ({ GET } = await import('@/app/api/health/route'));
});

afterEach(() => {
  queryBehavior = async () => ({ rows: [{ result: 1 }] });
  recorded.length = 0;
});

afterAll(() => {
  // Don't leak this file's injected pool or env to later files in the same
  // process — otherwise the real-Neon integration suites would see the fake URL
  // and skip/fail when the whole tree runs as one `bun test`.
  resetPool();
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

describe('GET /api/health', () => {
  test('returns 200 and ok=true when the probe succeeds', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthPayload;
    expect(body.ok).toBe(true);
    expect(body.db).toBe('up');
    expect(body.config_loaded).toBe(true);
  });

  test('returns 503 and ok=false when the probe rejects', async () => {
    queryBehavior = async () => {
      throw new Error('ECONNREFUSED');
    };
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthPayload;
    expect(body.ok).toBe(false);
    expect(body.db).toBe('down');
  });

  test('reports db=down on a slow probe rather than hanging', async () => {
    queryBehavior = () => new Promise(() => undefined); // never resolves
    const res = await GET();
    const body = (await res.json()) as HealthPayload;
    expect(body.db).toBe('down');
  }, 10_000);
});

describe('checkDb — bounded probe does not leak session state', () => {
  test('runs SELECT 1 in a transaction with a transaction-local statement_timeout', async () => {
    const state = await checkDb(1234);
    expect(state).toBe('up');
    expect(recorded.map((r) => r.sql)).toEqual([
      'BEGIN',
      "SELECT set_config('statement_timeout', $1, true)",
      'SELECT 1',
      'COMMIT',
    ]);
    // is_local = true (the trailing `true` in set_config) scopes the timeout to
    // the transaction, and the bound is bound as a parameter, never inlined.
    const setCfg = recorded.find((r) => r.sql.includes('set_config'));
    expect(setCfg?.params).toEqual(['1234']);
  });

  test('rolls back and reports down when the probe query fails', async () => {
    queryBehavior = async () => {
      throw new Error('boom');
    };
    expect(await checkDb(1000)).toBe('down');
    expect(recorded.map((r) => r.sql)).toContain('ROLLBACK');
  });
});

describe('getPool — idle pool errors are swallowed, not fatal', () => {
  test('attaches an error handler that survives an idle-client error and never logs secrets', () => {
    // Drop the injected fake so `getPool` builds a *real* Neon pool: this asserts
    // the production construction wiring (the swallowing idle-error handler),
    // which an injected pool would bypass. Construction is lazy — no connection
    // is opened — so the fake DATABASE_URL is never dialed.
    setPoolForTest(undefined);
    const pool = getPool();

    const spy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // With no listener node-postgres would rethrow and crash the process.
      expect(() => pool.emit('error', new Error('idle connection reset'))).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0]?.[0]);
      expect(logged).toContain('Error'); // err.name only
      expect(logged).not.toContain('postgresql://'); // never the connection string
    } finally {
      spy.mockRestore();
      resetPool();
    }
  });
});
