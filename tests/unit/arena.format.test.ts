import { describe, expect, test } from 'bun:test';

import { EMPTY, formatCapital, formatScore, truncateName } from '@/lib/arena/format';

/**
 * The formatters must never route a value through a float: the displayed value
 * is always an exact prefix of the stored decimal string. These tests pin that
 * with values a float round-trip would corrupt.
 */

describe('formatCapital', () => {
  test('groups the integer part and keeps fixed truncated decimals', () => {
    expect(formatCapital('1000000')).toBe('1,000,000.00');
    expect(formatCapital('250000.123456789012345678')).toBe('250,000.12');
    expect(formatCapital('0')).toBe('0.00');
  });

  test('truncates, never rounds (displayed ⊆ stored)', () => {
    // 0.999… must not round up to 1.00 and imply capital that is not there.
    expect(formatCapital('0.999999')).toBe('0.99');
    expect(formatCapital('9.985', 2)).toBe('9.98');
  });

  test('preserves precision a float would destroy', () => {
    expect(formatCapital('10000.0000000000000001', 0)).toBe('10,000');
    expect(formatCapital('99999999999999999999.5', 1)).toBe('99,999,999,999,999,999,999.5');
  });

  test('fractionDigits = 0 drops the point', () => {
    expect(formatCapital('1234.99', 0)).toBe('1,234');
  });

  test('handles negatives and null', () => {
    expect(formatCapital('-2500.5', 1)).toBe('-2,500.5');
    expect(formatCapital(null)).toBe(EMPTY);
  });
});

describe('formatScore', () => {
  test('fixed one-decimal by default, truncated', () => {
    expect(formatScore('73.250')).toBe('73.2');
    expect(formatScore('7')).toBe('7.0');
    expect(formatScore('100')).toBe('100.0');
  });

  test('zero decimals drops the fraction', () => {
    expect(formatScore('73.9', 0)).toBe('73');
  });
});

describe('truncateName', () => {
  test('passes short names through', () => {
    expect(truncateName('seed-leader')).toBe('seed-leader');
  });

  test('truncates long names with an ellipsis at the budget', () => {
    const out = truncateName('x'.repeat(50), 10);
    expect([...out]).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  test('counts unicode code points, not UTF-16 units', () => {
    // Emoji are 2 UTF-16 units each; a naive slice would split a surrogate pair.
    expect(truncateName('😀😀😀😀😀', 3)).toBe('😀😀…');
  });
});
