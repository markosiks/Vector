import { describe, expect, test } from 'bun:test';

import { type Cursor, decodeCursor, encodeCursor } from '@/lib/api/cursor';
import { ApiError } from '@/lib/api/errors';

/**
 * The cursor is an untrusted, opaque token. It must round-trip exactly for the
 * values we mint, and reject everything else with a deterministic 400 — never a
 * 5xx and never a partially-decoded keyset that could reach SQL.
 */

const VALID: Cursor = { t: '2026-06-07T12:00:00.000Z', id: '55555555-5555-5555-5555-555555555555' };

describe('round-trip', () => {
  test('encode → decode is identity', () => {
    expect(decodeCursor(encodeCursor(VALID))).toEqual(VALID);
  });

  test('the token is opaque base64url (no JSON punctuation)', () => {
    const token = encodeCursor(VALID);
    expect(token).not.toContain('{');
    expect(token).not.toContain(':');
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
  });
});

describe('rejects malformed tokens with a 400', () => {
  const bad: Record<string, string> = {
    'not base64': 'not base64!!',
    'valid base64, not JSON': Buffer.from('hello world', 'utf8').toString('base64url'),
    'JSON but wrong shape': Buffer.from(JSON.stringify({ foo: 1 }), 'utf8').toString('base64url'),
    'extra keys (strict)': Buffer.from(JSON.stringify({ ...VALID, evil: 1 }), 'utf8').toString(
      'base64url',
    ),
    'non-ISO timestamp': Buffer.from(
      JSON.stringify({ t: 'yesterday', id: VALID.id }),
      'utf8',
    ).toString('base64url'),
    'non-uuid id': Buffer.from(JSON.stringify({ t: VALID.t, id: 'not-a-uuid' }), 'utf8').toString(
      'base64url',
    ),
    'sql injection in id': Buffer.from(
      JSON.stringify({ t: VALID.t, id: "1' OR '1'='1" }),
      'utf8',
    ).toString('base64url'),
    'empty string': '',
  };

  for (const [name, token] of Object.entries(bad)) {
    test(name, () => {
      expect(() => decodeCursor(token)).toThrow(ApiError);
      try {
        decodeCursor(token);
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).code).toBe('invalid_cursor');
      }
    });
  }
});
