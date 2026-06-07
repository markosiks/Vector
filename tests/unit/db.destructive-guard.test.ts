import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { assertDestructiveAllowed } from '@/scripts/db/_pool';

/**
 * Unit: the destructive-op opt-in guard. `db:reset` and `db:rollback --all` roll
 * every migration down (DROP every table) against whatever `DATABASE_URL` is in
 * the environment, so they are gated behind an explicit `VECTOR_ALLOW_DESTRUCTIVE`
 * flag. The guard is deterministic in the flag value and never inspects the
 * connection, so it is a pure unit.
 */

describe('assertDestructiveAllowed', () => {
  const original = process.env.VECTOR_ALLOW_DESTRUCTIVE;

  beforeEach(() => {
    delete process.env.VECTOR_ALLOW_DESTRUCTIVE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.VECTOR_ALLOW_DESTRUCTIVE;
    else process.env.VECTOR_ALLOW_DESTRUCTIVE = original;
  });

  test('throws (naming the action) when the flag is unset', () => {
    expect(() => assertDestructiveAllowed('db:reset')).toThrow(/db:reset/);
  });

  test('throws for any value other than exactly "1"', () => {
    for (const v of ['', '0', 'true', 'yes', 'YES']) {
      process.env.VECTOR_ALLOW_DESTRUCTIVE = v;
      expect(() => assertDestructiveAllowed('db:rollback --all')).toThrow();
    }
  });

  test('passes only when explicitly opted in with "1"', () => {
    process.env.VECTOR_ALLOW_DESTRUCTIVE = '1';
    expect(() => assertDestructiveAllowed('db:reset')).not.toThrow();
  });
});
