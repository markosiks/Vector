import { describe, expect, test } from 'bun:test';

import { EnvValidationError, parseEnv } from '@/lib/config/env.schema';

const VALID_DB = 'postgresql://user:pass@host.neon.tech/db?sslmode=require';

describe('parseEnv — happy path', () => {
  test('accepts a minimal valid environment', () => {
    const env = parseEnv({ DATABASE_URL: VALID_DB });
    expect(env.DATABASE_URL).toBe(VALID_DB);
    expect(env.MANTLE_TESTNET_RPC_URL).toBeUndefined();
  });

  test('accepts and trims optional values when well-formed', () => {
    const env = parseEnv({
      DATABASE_URL: VALID_DB,
      MANTLE_TESTNET_RPC_URL: '  https://rpc.sepolia.mantle.xyz  ',
      NANSEN_API_KEY: 'nansen-key',
      GIT_COMMIT: 'abc1234',
    });
    expect(env.MANTLE_TESTNET_RPC_URL).toBe('https://rpc.sepolia.mantle.xyz');
    expect(env.NANSEN_API_KEY).toBe('nansen-key');
    expect(env.GIT_COMMIT).toBe('abc1234');
  });
});

describe('parseEnv — required DATABASE_URL', () => {
  test('throws when missing', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
  });

  test('rejects an empty string', () => {
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrow(EnvValidationError);
  });

  test('rejects whitespace-only', () => {
    expect(() => parseEnv({ DATABASE_URL: '   ' })).toThrow(EnvValidationError);
  });

  test('rejects a non-postgres scheme', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://host/db' })).toThrow(EnvValidationError);
  });

  test('rejects a non-URL value', () => {
    expect(() => parseEnv({ DATABASE_URL: 'not a url' })).toThrow(EnvValidationError);
  });

  test('rejects an oversized value deterministically', () => {
    const huge = `postgresql://u:p@host/db?x=${'a'.repeat(5_000)}`;
    expect(() => parseEnv({ DATABASE_URL: huge })).toThrow(EnvValidationError);
  });

  test('accepts both postgres:// and postgresql://', () => {
    expect(() => parseEnv({ DATABASE_URL: 'postgres://u:p@h/db' })).not.toThrow();
    expect(() => parseEnv({ DATABASE_URL: 'postgresql://u:p@h/db' })).not.toThrow();
  });
});

describe('parseEnv — optional values validated when present', () => {
  test('rejects an RPC URL with a bad protocol', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: VALID_DB, MANTLE_TESTNET_RPC_URL: 'ftp://rpc/host' }),
    ).toThrow(EnvValidationError);
  });

  test('accepts ws(s) RPC URLs', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: VALID_DB, MANTLE_TESTNET_RPC_URL: 'wss://rpc.host' }),
    ).not.toThrow();
  });

  test('accepts an http(s) PUBLIC_BASE_URL', () => {
    const env = parseEnv({ DATABASE_URL: VALID_DB, PUBLIC_BASE_URL: '  https://vector.app  ' });
    expect(env.PUBLIC_BASE_URL).toBe('https://vector.app');
  });

  test('rejects a ws(s) PUBLIC_BASE_URL (the feedbackURI must be HTTP-fetchable)', () => {
    expect(() => parseEnv({ DATABASE_URL: VALID_DB, PUBLIC_BASE_URL: 'wss://vector.app' })).toThrow(
      EnvValidationError,
    );
  });

  test('rejects an empty optional secret when the key is present', () => {
    expect(() => parseEnv({ DATABASE_URL: VALID_DB, NANSEN_API_KEY: '   ' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('parseEnv — error messages never leak secret values', () => {
  test('message references the variable name but not its value', () => {
    const secret = 'postgresql-but-with-a-typo-SUPERSECRET-VALUE';
    try {
      parseEnv({ DATABASE_URL: secret });
      throw new Error('expected parseEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const message = (err as EnvValidationError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('SUPERSECRET-VALUE');
      expect(message).not.toContain(secret);
    }
  });

  test('aggregates multiple issues without echoing values', () => {
    try {
      parseEnv({ DATABASE_URL: 'bad', MANTLE_TESTNET_RPC_URL: 'also-bad' });
      throw new Error('expected parseEnv to throw');
    } catch (err) {
      const e = err as EnvValidationError;
      expect(e.issues.length).toBe(2);
      expect(e.message).toContain('DATABASE_URL');
      expect(e.message).toContain('MANTLE_TESTNET_RPC_URL');
      expect(e.message).not.toContain('also-bad');
    }
  });
});
