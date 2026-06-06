import { describe, expect, test } from 'bun:test';

import { EnvValidationError, parseEnv } from '@/lib/config/env.schema';

/**
 * Property: for arbitrary `DATABASE_URL` input, `parseEnv` either returns a
 * valid env or throws a typed {@link EnvValidationError}. It must never throw an
 * untyped error, panic, or hang. Generators are seeded for determinism.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ' \t\n\r\0abcABC0129:/?@.%&=#-_<>"\'\\{}[]\u00e9\u4e2d\u0007\uFFFD' + 'postgresql';

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    const idx = Math.floor(rand() * ALPHABET.length);
    out += ALPHABET[idx] ?? '';
  }
  return out;
}

describe('parseEnv fuzz — DATABASE_URL', () => {
  test('1000 arbitrary inputs are accepted or typed-rejected, never crash', () => {
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < 1000; i += 1) {
      const candidate = randomString(rand, 200);
      try {
        const env = parseEnv({ DATABASE_URL: candidate });
        // If accepted, the parsed value must be a postgres URL.
        const { protocol } = new URL(env.DATABASE_URL);
        expect(['postgres:', 'postgresql:']).toContain(protocol);
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        expect((err as EnvValidationError).message).toContain('DATABASE_URL');
      }
    }
  });
});

describe('parseEnv fuzz — extra/unknown keys and optionals', () => {
  test('unknown keys are ignored; optionals are validated or rejected', () => {
    const rand = mulberry32(0x1234);
    for (let i = 0; i < 500; i += 1) {
      const source: Record<string, string | undefined> = {
        DATABASE_URL: 'postgresql://u:p@h/db',
        [`UNKNOWN_${i}`]: randomString(rand, 50),
        MANTLE_TESTNET_RPC_URL: randomString(rand, 80),
      };
      try {
        const env = parseEnv(source);
        // RPC, if accepted, must be a known scheme; unknown keys never appear.
        if (env.MANTLE_TESTNET_RPC_URL !== undefined) {
          const { protocol } = new URL(env.MANTLE_TESTNET_RPC_URL);
          expect(['http:', 'https:', 'ws:', 'wss:']).toContain(protocol);
        }
        expect(Object.keys(env)).not.toContain(`UNKNOWN_${i}`);
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
      }
    }
  });
});
