import { describe, expect, test } from 'bun:test';

import { EMPTY } from '@/lib/arena/format';
import {
  formatAttestationValue,
  formatFactor,
  formatPoints,
  formatSignedCapital,
  formatTimestamp,
} from '@/lib/credibility/format';

/**
 * Signed money keeps the precision-safe truncation of `formatCapital` and only
 * adds a leading sign; the explainability formatters render plain fixed numbers.
 */

describe('formatSignedCapital', () => {
  test('prefixes a + on a positive, keeps the − on a negative', () => {
    expect(formatSignedCapital('1234.5', 2)).toBe('+1,234.50');
    expect(formatSignedCapital('-1234.5', 2)).toBe('-1,234.50');
  });

  test('zero is unsigned, null is EMPTY', () => {
    expect(formatSignedCapital('0', 2)).toBe('0.00');
    expect(formatSignedCapital(null)).toBe(EMPTY);
  });

  test('preserves precision a float would destroy', () => {
    expect(formatSignedCapital('1000.000000000000000001', 0)).toBe('+1,000');
  });
});

describe('formatAttestationValue', () => {
  test('value_decimals = 0 renders the grouped integer score', () => {
    expect(formatAttestationValue('73', 0)).toBe('73');
    expect(formatAttestationValue('100', 0)).toBe('100');
  });

  test('scales by value_decimals via string surgery (no float)', () => {
    expect(formatAttestationValue('73250', 3)).toBe('73.250');
    expect(formatAttestationValue('5', 3)).toBe('0.005');
  });

  test('preserves a 39-digit value a float would corrupt', () => {
    const v = '170141183460469231731687303715884105727';
    expect(formatAttestationValue(v, 0)).toBe(
      '170,141,183,460,469,231,731,687,303,715,884,105,727',
    );
  });

  test('non-integer or odd input is returned unchanged, never throws', () => {
    expect(formatAttestationValue('not-a-number', 0)).toBe('not-a-number');
    expect(formatAttestationValue('1.5', 0)).toBe('1.5');
  });
});

describe('formatTimestamp', () => {
  test('renders UTC YYYY-MM-DD HH:MM:SSZ regardless of locale', () => {
    expect(formatTimestamp('2026-06-07T12:00:00.000Z')).toBe('2026-06-07 12:00:00Z');
    // A non-UTC offset is normalized to UTC.
    expect(formatTimestamp('2026-06-07T14:00:00+02:00')).toBe('2026-06-07 12:00:00Z');
  });

  test('null and unparseable values are EMPTY, never Invalid Date', () => {
    expect(formatTimestamp(null)).toBe(EMPTY);
    expect(formatTimestamp('not-a-date')).toBe(EMPTY);
  });
});

describe('formatFactor', () => {
  test('three decimals; non-finite is EMPTY', () => {
    expect(formatFactor(0.5)).toBe('0.500');
    expect(formatFactor(0)).toBe('0.000');
    expect(formatFactor(Number.NaN)).toBe(EMPTY);
  });
});

describe('formatPoints', () => {
  test('trims trailing zeros and signs only when asked', () => {
    expect(formatPoints(5)).toBe('5');
    expect(formatPoints(-3.5)).toBe('-3.5');
    expect(formatPoints(5, true)).toBe('+5');
    expect(formatPoints(-3.5, true)).toBe('-3.5');
    expect(formatPoints(0, true)).toBe('0');
    expect(formatPoints(Number.POSITIVE_INFINITY)).toBe(EMPTY);
  });
});
