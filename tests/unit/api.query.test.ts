import { describe, expect, test } from 'bun:test';

import { ApiError } from '@/lib/api/errors';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseChainState,
  parseCursor,
  parseLimit,
  parseUuid,
} from '@/lib/api/query';

/** Query-param parsers: every input maps to a typed value or a 400, never both. */

describe('parseLimit', () => {
  test('omitted or empty → default', () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
  });

  test('a valid integer passes through', () => {
    expect(parseLimit('25')).toBe(25);
    expect(parseLimit('1')).toBe(1);
  });

  test('a huge limit is clamped to the cap, not rejected', () => {
    expect(parseLimit('100000')).toBe(MAX_LIMIT);
    expect(parseLimit(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_LIMIT);
  });

  test.each(['0', '-1', '-5', '1.5', '5.0', '1e3', '0x10', ' 5', '5 ', 'abc', 'NaN', '٥'])(
    'rejects %p with a 400',
    (raw) => {
      expect(() => parseLimit(raw)).toThrow(ApiError);
      try {
        parseLimit(raw);
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).code).toBe('invalid_limit');
      }
    },
  );
});

describe('parseChainState', () => {
  test('omitted → undefined (no filter)', () => {
    expect(parseChainState(null)).toBeUndefined();
    expect(parseChainState('')).toBeUndefined();
  });

  test.each(['optimistic', 'confirmed', 'failed'])('accepts the enum value %p', (s) => {
    expect(parseChainState(s)).toBe(s as 'optimistic' | 'confirmed' | 'failed');
  });

  test.each(['Optimistic', 'pending', "optimistic' OR 1=1", 'null'])(
    'rejects %p with a 400',
    (raw) => {
      expect(() => parseChainState(raw)).toThrow(ApiError);
      try {
        parseChainState(raw);
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).code).toBe('invalid_chain_state');
      }
    },
  );
});

describe('parseUuid', () => {
  test('accepts a well-formed uuid', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    expect(parseUuid(id)).toBe(id);
  });

  test.each([
    'not-a-uuid',
    '11111111-1111-1111-1111-11111111111', // too short
    '11111111111111111111111111111111',
    "1' OR '1'='1",
    '../../etc/passwd',
  ])('rejects %p with a 400 invalid_id', (raw) => {
    expect(() => parseUuid(raw)).toThrow(ApiError);
    try {
      parseUuid(raw);
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe('invalid_id');
    }
  });
});

describe('parseCursor', () => {
  test('omitted → null', () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor('')).toBeNull();
  });

  test('a malformed token is a 400, never a throw of another kind', () => {
    expect(() => parseCursor('not-base64!!')).toThrow(ApiError);
  });
});
