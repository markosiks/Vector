import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

/**
 * Regression tests for C-02: the `ENV` singleton must be runtime-frozen.
 * TypeScript's `Readonly` is compile-time only; `deepFreeze` provides
 * the actual runtime protection.
 *
 * `server-only` is mocked because it is a no-op guard that throws in
 * non-Next environments — fine to bypass in unit tests.
 */

mock.module('server-only', () => ({}));

// Provide a minimal valid env so `parseEnv` succeeds when `env.ts` is imported.
const prevDbUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= 'postgresql://user:pass@host.neon.tech/db?sslmode=require';

afterAll(() => {
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

let ENV: Record<string, unknown>;

beforeAll(async () => {
  ENV = (await import('@/lib/config/env')).ENV as Record<string, unknown>;
});

describe('ENV singleton — C-02: runtime immutability', () => {
  test('the ENV object is frozen at runtime', () => {
    expect(Object.isFrozen(ENV)).toBe(true);
  });

  test('attempting to mutate ENV.DATABASE_URL throws in strict mode', () => {
    expect(() => {
      ENV['DATABASE_URL'] = 'postgresql://evil/db';
    }).toThrow();
  });

  test('re-importing env.ts yields the same frozen reference', async () => {
    const a = (await import('@/lib/config/env')).ENV;
    const b = (await import('@/lib/config/env')).ENV;
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});
