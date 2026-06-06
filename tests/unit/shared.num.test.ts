import { describe, expect, test } from 'bun:test';

import { num } from '@/lib/db/repos/_shared';

describe('num', () => {
  test('passes a decimal string through verbatim (exact, no float round-trip)', () => {
    expect(num('0.30000000000000004')).toBe('0.30000000000000004');
    expect(num('170141183460469231731687303715884105727')).toBe(
      '170141183460469231731687303715884105727',
    );
  });

  test('stringifies a bigint exactly, including int128-scale values', () => {
    expect(num(50n)).toBe('50');
    expect(num(170141183460469231731687303715884105727n)).toBe(
      '170141183460469231731687303715884105727',
    );
  });

  test('accepts an exactly-representable safe integer number', () => {
    expect(num(42)).toBe('42');
    expect(num(0)).toBe('0');
    expect(num(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  test('rejects a non-integer number rather than persisting a float artifact', () => {
    expect(() => num(0.1 + 0.2)).toThrow();
    expect(() => num(12.5)).toThrow();
  });

  test('rejects an integer past 2^53 that has already lost precision', () => {
    expect(() => num(9007199254740993)).toThrow();
    expect(() => num(2 ** 53)).toThrow();
  });

  test('rejects NaN and Infinity', () => {
    expect(() => num(NaN)).toThrow();
    expect(() => num(Infinity)).toThrow();
    expect(() => num(-Infinity)).toThrow();
  });
});
