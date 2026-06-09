import { describe, expect, test } from 'bun:test';

import {
  constantTimeEqual,
  deriveSessionToken,
  verifyOperatorToken,
  verifySessionToken,
} from '@/lib/operator/token';

/**
 * Fuzz: the operator-token core must never accept a wrong credential and never
 * throw on adversarial input. We hammer it with random tokens, near-misses, and
 * junk types to assert the two invariants that matter: only an exact match is
 * accepted, and the comparison is total (no exception escapes).
 */

function randomString(rng: () => number, maxLen = 48): string {
  const len = Math.floor(rng() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(32 + Math.floor(rng() * 94));
  return s;
}

// Small deterministic LCG so the fuzz run is reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('verifyOperatorToken — only an exact match is accepted', () => {
  test('1000 random (token, configured) pairs: accept iff equal', () => {
    const rng = lcg(0xc0ffee);
    for (let i = 0; i < 1000; i++) {
      const configured = randomString(rng);
      const presented = rng() < 0.25 ? configured : randomString(rng);
      const expected = configured.length >= 1 && presented === configured;
      expect(verifyOperatorToken(presented, configured)).toBe(expected);
    }
  });

  test('a one-character mutation is always rejected', () => {
    const rng = lcg(42);
    for (let i = 0; i < 500; i++) {
      const token = randomString(rng, 40);
      if (token.length === 0) continue;
      const pos = Math.floor(rng() * token.length);
      const mutated =
        token.slice(0, pos) + String.fromCharCode(token.charCodeAt(pos) ^ 1) + token.slice(pos + 1);
      expect(verifyOperatorToken(mutated, token)).toBe(false);
    }
  });
});

describe('totality — never throws on junk input', () => {
  const junk: unknown[] = [undefined, null, 0, 1, NaN, {}, [], true, Symbol('x'), () => 0];
  test('constantTimeEqual returns a boolean for any input pair', () => {
    for (const a of junk) {
      for (const b of junk) {
        expect(typeof constantTimeEqual(a, b)).toBe('boolean');
      }
    }
  });
  test('verify* return false (never throw) for unconfigured / junk', () => {
    for (const j of junk) {
      expect(verifyOperatorToken(j, undefined)).toBe(false);
      expect(verifyOperatorToken('x'.repeat(30), j as string | undefined)).toBe(false);
      expect(verifySessionToken(j, 'configured-token-1234567890')).toBe(false);
    }
  });
});

describe('session digest round-trips for any token', () => {
  test('verifySessionToken accepts exactly the derived digest', () => {
    const rng = lcg(7);
    for (let i = 0; i < 500; i++) {
      const token = randomString(rng, 40);
      if (token.length === 0) continue;
      expect(verifySessionToken(deriveSessionToken(token), token)).toBe(true);
      // A digest of a different token never validates.
      const other = `${token}x`;
      expect(verifySessionToken(deriveSessionToken(other), token)).toBe(false);
    }
  });
});
