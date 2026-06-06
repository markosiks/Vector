import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';

import type { DbState, HealthPayload } from '@/lib/health';

/**
 * Tests the `/api/health` route handler end-to-end in-process by mocking only
 * the trust boundaries: `server-only` (a no-op outside Next) and the Neon
 * driver. The route + db-client + health-formatter wiring is exercised for
 * real, without a server or a live database.
 */

// Controls what the mocked Neon pool's `SELECT 1` does, per test.
let queryBehavior: () => Promise<unknown> = async () => ({ rows: [{ result: 1 }] });

// Every query the probe issues, in order (for asserting the transaction shape).
const recorded: { sql: string; params?: readonly unknown[] | undefined }[] = [];
// Pools the mocked driver has constructed (for emitting an idle 'error').
const pools: MockPool[] = [];

// A valid DB string so eager env validation passes when the route imports env.
process.env.DATABASE_URL = 'postgresql://user:pass@host.neon.tech/db?sslmode=require';

/**
 * A fake Neon pool: records each query, exposes the EventEmitter surface
 * (`on`/`emit`) the idle-error handler needs, and routes only `SELECT 1` through
 * `queryBehavior` so a test can make the probe fail or hang while BEGIN/COMMIT/
 * ROLLBACK still resolve.
 */
class MockPool {
  private readonly handlers = new Map<string, (err: Error) => void>();

  constructor() {
    pools.push(this);
  }

  on(event: string, handler: (err: Error) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, err: Error): void {
    this.handlers.get(event)?.(err);
  }

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
mock.module('@neondatabase/serverless', () => ({ Pool: MockPool }));

let GET: () => Promise<Response>;
let resetPool: () => void;
let getPool: () => MockPool;
let checkDb: (timeoutMs?: number) => Promise<DbState>;

beforeAll(async () => {
  // The Neon pool is a process singleton: a prior test file may have primed (or
  // ended) it with the real driver, which would defeat the mock above. Drop it
  // so `checkDb` rebuilds a pool from the mocked driver on the first request.
  const client = await import('@/lib/db/client');
  resetPool = client.resetPool;
  getPool = client.getPool as unknown as () => MockPool;
  checkDb = client.checkDb;
  resetPool();
  ({ GET } = await import('@/app/api/health/route'));
});

afterEach(() => {
  queryBehavior = async () => ({ rows: [{ result: 1 }] });
  recorded.length = 0;
});

afterAll(() => {
  // Don't leak this file's mocked pool to later test files in the same process.
  resetPool();
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
    resetPool();
    pools.length = 0;
    const pool = getPool();
    expect(pools).toHaveLength(1);

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
