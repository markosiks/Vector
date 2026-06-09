import { describe, expect, test } from 'bun:test';

import {
  constantTimeEqual,
  deriveSessionToken,
  verifyOperatorToken,
  verifySessionToken,
} from '@/lib/operator/token';

/**
 * Unit: the pure operator-token core. Each input class — match, mismatch, length
 * mismatch, non-string, unconfigured console — must collapse to a deterministic
 * boolean, and the session digest must round-trip while never being the raw
 * token. The fail-closed rule (no configured token ⇒ reject everything) is the
 * load-bearing security invariant and is asserted explicitly.
 */

const TOKEN = 'operator-secret-token-abcdef-0123456789'; // ≥ 24 chars

describe('constantTimeEqual', () => {
  test('equal strings match', () => {
    expect(constantTimeEqual('alpha-bravo', 'alpha-bravo')).toBe(true);
  });

  test('different same-length strings do not match', () => {
    expect(constantTimeEqual('alpha-bravo', 'alpha-bravX')).toBe(false);
  });

  test('different-length strings do not match (no throw)', () => {
    expect(constantTimeEqual('short', 'a-much-longer-value')).toBe(false);
  });

  test('non-string inputs never match', () => {
    expect(constantTimeEqual(undefined, 'x')).toBe(false);
    expect(constantTimeEqual('x', undefined)).toBe(false);
    expect(constantTimeEqual(123 as unknown, '123')).toBe(false);
    expect(constantTimeEqual(null, null)).toBe(false);
  });

  test('multibyte strings compare by bytes, not code units', () => {
    expect(constantTimeEqual('café', 'café')).toBe(true);
    expect(constantTimeEqual('café', 'cafe')).toBe(false);
  });
});

describe('verifyOperatorToken', () => {
  test('accepts only the exact configured token', () => {
    expect(verifyOperatorToken(TOKEN, TOKEN)).toBe(true);
    expect(verifyOperatorToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(verifyOperatorToken(TOKEN.slice(0, -1), TOKEN)).toBe(false);
  });

  test('fail-closed: an unconfigured console rejects every token', () => {
    expect(verifyOperatorToken(TOKEN, undefined)).toBe(false);
    expect(verifyOperatorToken(TOKEN, '')).toBe(false);
    expect(verifyOperatorToken('', '')).toBe(false);
  });
});

describe('session digest', () => {
  test('derives a stable sha256 hex that is not the raw token', () => {
    const digest = deriveSessionToken(TOKEN);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(TOKEN);
    expect(deriveSessionToken(TOKEN)).toBe(digest); // deterministic
  });

  test('verifySessionToken accepts the matching digest only', () => {
    const digest = deriveSessionToken(TOKEN);
    expect(verifySessionToken(digest, TOKEN)).toBe(true);
    expect(verifySessionToken(TOKEN, TOKEN)).toBe(false); // raw token is not the cookie
    expect(verifySessionToken(deriveSessionToken('other'), TOKEN)).toBe(false);
  });

  test('fail-closed: no configured token rejects any cookie', () => {
    expect(verifySessionToken(deriveSessionToken(TOKEN), undefined)).toBe(false);
    expect(verifySessionToken(deriveSessionToken(TOKEN), '')).toBe(false);
    expect(verifySessionToken('', TOKEN)).toBe(false);
    expect(verifySessionToken(undefined, TOKEN)).toBe(false);
  });
});
