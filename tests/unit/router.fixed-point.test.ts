import { describe, expect, test } from 'bun:test';

import {
  apportion,
  formatUnits,
  parseUnits,
  ratioToFixed,
  subtractFixed,
  toUnits,
} from '@/lib/router/fixed-point';

/**
 * Unit coverage for the router's exact fixed-point arithmetic (§6.2). The pool
 * is conserved on integers, so {@link apportion} is the load-bearing invariant:
 * its parts must sum to the total *exactly*, deterministically, for any weight
 * vector — including all-equal, all-zero, heavy-tailed, and adversarial draws.
 */

/** Sum a bigint array. */
function sum(xs: readonly bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}

describe('apportion — exact conservation', () => {
  test('parts always sum to the total, for representative weight vectors', () => {
    const total = 10n ** 24n; // 1e6 pool at 18-dp units
    const vectors: number[][] = [
      [1, 1, 1],
      [0.5, 0.3, 0.2],
      [1, 0, 0],
      [0, 0, 0], // no mass → uniform, still conserves
      [1e9, 1, 1], // heavy tail
      [0.3333333, 0.3333333, 0.3333334],
      Array.from({ length: 97 }, (_, i) => i + 1), // many agents, awkward ratios
    ];
    for (const w of vectors) {
      const parts = apportion(w, total);
      expect(sum(parts)).toBe(total);
      for (const p of parts) expect(p >= 0n).toBe(true);
    }
  });

  test('is deterministic and breaks remainder ties by ascending index', () => {
    // Three equal weights over a total ≡ 1 (mod 3): the single leftover unit goes
    // to index 0, never elsewhere, on every run.
    const total = 7n;
    const a = apportion([1, 1, 1], total);
    const b = apportion([1, 1, 1], total);
    expect(a).toEqual(b);
    expect(a).toEqual([3n, 2n, 2n]);
  });

  test('clamps negative / non-finite weights to zero', () => {
    const parts = apportion([-5, Number.NaN, 2, 1], 100n);
    expect(sum(parts)).toBe(100n);
    expect(parts[0]).toBe(0n);
    expect(parts[1]).toBe(0n);
    // Mass split 2:1 between the last two.
    expect(parts[2]).toBe(67n);
    expect(parts[3]).toBe(33n);
  });

  test('a zero total distributes nothing; an empty vector is empty', () => {
    expect(apportion([1, 2, 3], 0n)).toEqual([0n, 0n, 0n]);
    expect(apportion([], 0n)).toEqual([]);
  });

  test('rejects a negative total and a positive total over zero agents', () => {
    expect(() => apportion([1], -1n)).toThrow(RangeError);
    expect(() => apportion([], 5n)).toThrow(RangeError);
  });
});

describe('toUnits / formatUnits / parseUnits — exact round-trip', () => {
  test('toUnits scales a decimal by a power of ten without float error', () => {
    expect(toUnits(1_000_000, 18)).toBe(10n ** 24n);
    expect(toUnits(0, 18)).toBe(0n);
    expect(toUnits(0.1, 8)).toBe(10_000_000n);
  });

  test('parseUnits reads a 24-digit amount string exactly (no float round-trip)', () => {
    const s = '583333.333333333333333334';
    expect(parseUnits(s, 18)).toBe(583_333_333_333_333_333_333_334n);
    // round-trips back to the same canonical string
    expect(formatUnits(parseUnits(s, 18), 18)).toBe(s);
  });

  test('parseUnits truncates fractional digits beyond scale and handles signs', () => {
    expect(parseUnits('0.123456789', 8)).toBe(12_345_678n); // truncated, not rounded
    expect(parseUnits('-0.5', 8)).toBe(-50_000_000n);
    expect(parseUnits('+1.0', 0)).toBe(1n);
  });

  test('parseUnits rejects a non-decimal string; format/units reject negatives', () => {
    expect(() => parseUnits('1.2.3', 8)).toThrow(RangeError);
    expect(() => parseUnits('abc', 8)).toThrow(RangeError);
    expect(() => formatUnits(-1n, 8)).toThrow(RangeError);
    expect(() => toUnits(-1, 8)).toThrow(RangeError);
    expect(() => toUnits(Number.POSITIVE_INFINITY, 8)).toThrow(RangeError);
  });

  test('formatUnits always emits exactly `scale` fractional digits', () => {
    expect(formatUnits(5n, 8)).toBe('0.00000005');
    expect(formatUnits(10n ** 8n, 8)).toBe('1.00000000');
    expect(formatUnits(123n, 0)).toBe('123');
  });
});

describe('ratioToFixed / subtractFixed', () => {
  test('ratioToFixed quantizes a ratio half-up to the column scale', () => {
    expect(ratioToFixed(1n, 3n, 8)).toBe('0.33333333');
    expect(ratioToFixed(2n, 3n, 8)).toBe('0.66666667'); // rounded up
    expect(ratioToFixed(0n, 5n, 8)).toBe('0.00000000');
    expect(ratioToFixed(5n, 5n, 8)).toBe('1.00000000');
  });

  test('ratioToFixed rejects a non-positive denominator', () => {
    expect(() => ratioToFixed(1n, 0n, 8)).toThrow(RangeError);
  });

  test('subtractFixed is exact and signed at the given scale', () => {
    expect(subtractFixed('0.58333333', '0.33333333', 8)).toBe('0.25000000');
    expect(subtractFixed('0.00000000', '0.58333333', 8)).toBe('-0.58333333');
    expect(subtractFixed('1.00000000', '1.00000000', 8)).toBe('0.00000000');
  });
});
