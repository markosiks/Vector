import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

import type { HealthPayload } from '@/lib/health';

/**
 * Tests the `/api/health` route handler end-to-end in-process by mocking only
 * the trust boundaries: `server-only` (a no-op outside Next) and the Neon
 * driver. The route + db-client + health-formatter wiring is exercised for
 * real, without a server or a live database.
 */

// Controls what the mocked Neon pool's `SELECT 1` does, per test.
let queryBehavior: () => Promise<unknown> = async () => ({ rows: [{ result: 1 }] });

// A valid DB string so eager env validation passes when the route imports env.
process.env.DATABASE_URL = 'postgresql://user:pass@host.neon.tech/db?sslmode=require';

mock.module('server-only', () => ({}));
mock.module('@neondatabase/serverless', () => ({
  // checkDb probes on a dedicated pooled client (connect → query → release),
  // so the fake models that shape; `queryBehavior` drives every client query.
  Pool: class {
    async connect(): Promise<{ query: () => Promise<unknown>; release: () => void }> {
      return {
        query: (): Promise<unknown> => queryBehavior(),
        release: (): void => undefined,
      };
    }
  },
}));

let GET: () => Promise<Response>;
let resetPool: () => void;

beforeAll(async () => {
  // The Neon pool is a process singleton: a prior test file may have primed (or
  // ended) it with the real driver, which would defeat the mock above. Drop it
  // so `checkDb` rebuilds a pool from the mocked driver on the first request.
  ({ resetPool } = await import('@/lib/db/client'));
  resetPool();
  ({ GET } = await import('@/app/api/health/route'));
});

afterEach(() => {
  queryBehavior = async () => ({ rows: [{ result: 1 }] });
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
