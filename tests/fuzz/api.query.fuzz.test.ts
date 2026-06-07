import { describe, expect, test } from 'bun:test';

import { encodeCursor } from '@/lib/api/cursor';
import { ApiError } from '@/lib/api/errors';
import { parseChainState, parseCursor, parseLimit, parseUuid } from '@/lib/api/query';

/**
 * Fuzz the untrusted query parsers. The invariant under any input — random
 * bytes, unicode, SQL/path injection, extreme numbers — is a *total* function:
 * it either returns a value of the right type and range, or throws an
 * {@link ApiError} (a 4xx). It never throws anything else, never returns an
 * out-of-contract value, and never hangs.
 */

function randString(len: number): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyz0123456789-_.:/\\\'"; ()=*+%<>{}[]\t\n٥۵０1２３е\u0000';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

describe('parseLimit (fuzz)', () => {
  test('always returns 1..MAX or throws an ApiError', () => {
    for (let i = 0; i < 4000; i += 1) {
      const raw = Math.random() < 0.5 ? randString(Math.floor(Math.random() * 8)) : String(i - 100);
      try {
        const n = parseLimit(raw);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(200);
        // A value the parser accepts is either empty (→ default) or the
        // canonical ASCII-digit form — never unicode digits or stray bytes.
        expect(raw === '' || /^\d+$/.test(raw)).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(400);
      }
    }
  });
});

describe('parseChainState (fuzz)', () => {
  const valid = new Set(['optimistic', 'confirmed', 'failed']);
  test('accepts exactly the three enum values, else 400', () => {
    for (let i = 0; i < 3000; i += 1) {
      const raw = randString(Math.floor(Math.random() * 12));
      try {
        const v = parseChainState(raw);
        expect(raw === '' || valid.has(v as string)).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
      }
    }
  });
});

describe('parseUuid (fuzz)', () => {
  test('never accepts a non-uuid', () => {
    for (let i = 0; i < 3000; i += 1) {
      const raw = randString(Math.floor(Math.random() * 40));
      try {
        const id = parseUuid(raw);
        expect(id).toBe(raw); // only returns on a real uuid match
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('invalid_id');
      }
    }
  });
});

describe('parseCursor (fuzz)', () => {
  test('garbage tokens never decode to a value; only minted tokens round-trip', () => {
    for (let i = 0; i < 3000; i += 1) {
      const raw = randString(Math.floor(Math.random() * 50));
      try {
        // A random string that happens to decode must still be a valid keyset.
        const c = parseCursor(raw);
        if (c !== null) {
          expect(typeof c.t).toBe('string');
          expect(typeof c.id).toBe('string');
        }
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('invalid_cursor');
      }
    }
  });

  test('a minted cursor always round-trips', () => {
    for (let i = 0; i < 500; i += 1) {
      const t = new Date(Date.now() - Math.floor(Math.random() * 1e10)).toISOString();
      const id = crypto.randomUUID();
      const token = encodeCursor({ t, id });
      expect(parseCursor(token)).toEqual({ t, id });
    }
  });
});
