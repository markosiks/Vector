import { describe, expect, test } from 'bun:test';

import { compareDecimal, normalizeDecimal } from '@/lib/intent/canonical';

describe('compareDecimal', () => {
  test('equal values compare 0 regardless of input form', () => {
    expect(compareDecimal('1', 1)).toBe(0);
    expect(compareDecimal('1.0', '1')).toBe(0);
    expect(compareDecimal('0', '-0')).toBe(0);
    expect(compareDecimal('10000', 10_000)).toBe(0);
  });

  test('orders by integer magnitude (digit count then lexicographic)', () => {
    expect(compareDecimal('9', '10')).toBe(-1);
    expect(compareDecimal('100', '99')).toBe(1);
    expect(compareDecimal('123', '124')).toBe(-1);
  });

  test('orders fractional parts at full precision', () => {
    expect(compareDecimal('1.1', '1.10001')).toBe(-1);
    expect(compareDecimal('0.2', '0.19999')).toBe(1);
    // The precision that a float round-trip would destroy:
    expect(compareDecimal('10000.0000000000000001', 10_000)).toBe(1);
  });

  test('handles signs', () => {
    expect(compareDecimal('-1', '1')).toBe(-1);
    expect(compareDecimal('-5', '-4')).toBe(-1);
    expect(compareDecimal('-4', '-5')).toBe(1);
    expect(compareDecimal('0', '-1')).toBe(1);
  });

  test('is a total order consistent with normalizeDecimal equality', () => {
    const vals = ['-2', '-1.5', '0', '0.0001', '1', '1.5', '2', '10', '100.25'];
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals.length; j++) {
        const c = compareDecimal(vals[i]!, vals[j]!);
        const eq = normalizeDecimal(vals[i]!) === normalizeDecimal(vals[j]!);
        if (eq) expect(c).toBe(0);
        else expect(c).toBe(i < j ? -1 : 1);
      }
    }
  });
});
