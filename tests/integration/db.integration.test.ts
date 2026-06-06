import { afterAll, describe, expect, mock, test } from 'bun:test';

/**
 * Integration tests against a **real** Neon database. They are skipped unless
 * `DATABASE_URL` is set, so CI without a database stays green. To run them:
 *
 *   DATABASE_URL='postgresql://…' bun test tests/integration
 *
 * `server-only` is neutralized because these tests import the db client
 * directly, outside the Next runtime.
 */

const hasDb = typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0;
const describeDb = hasDb ? describe : describe.skip;

// Neutralize the server-only guard for direct import in the test runtime.
mock.module('server-only', () => ({}));

describeDb('Neon connectivity (real DATABASE_URL)', () => {
  test('checkDb resolves "up" on a healthy connection', async () => {
    const { checkDb } = await import('@/lib/db/client');
    expect(await checkDb()).toBe('up');
  });

  test('the pool is a singleton (reused across calls)', async () => {
    const { getPool } = await import('@/lib/db/client');
    expect(getPool()).toBe(getPool());
  });

  test('concurrent probes all succeed under reuse', async () => {
    const { checkDb } = await import('@/lib/db/client');
    const results = await Promise.all(Array.from({ length: 8 }, () => checkDb()));
    expect(results.every((r) => r === 'up')).toBe(true);
  });

  test('a tiny timeout degrades to "down" rather than throwing', async () => {
    const { checkDb } = await import('@/lib/db/client');
    expect(await checkDb(1)).toBe('down');
  });

  afterAll(async () => {
    const { getPool } = await import('@/lib/db/client');
    await getPool().end();
  });
});

describe('Neon connectivity (skipped without DATABASE_URL)', () => {
  test.skipIf(hasDb)('placeholder so the file always reports at least one test', () => {
    expect(hasDb).toBe(false);
  });
});
