import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { breakdownFrom, buildBreakdown, safeComponents } from '@/lib/credibility/components';
import { score } from '@/lib/scoring/score';

/**
 * The breakdown must reconstruct §6.1's composition — `100·perf·w + policy − dd`,
 * clamped to `[0,100]` — exactly, not as a flat sum, and must reject malformed
 * payloads to `null`. The headline test pins it against the real scorer so the
 * UI's reconstructed `raw_r` can never drift from the value P1.2 persisted.
 */

describe('safeComponents', () => {
  test('accepts a well-formed payload', () => {
    expect(safeComponents({ perf: 0.5, w: 0.4, policy: -3, dd: 1.2 })).toEqual({
      perf: 0.5,
      w: 0.4,
      policy: -3,
      dd: 1.2,
    });
  });

  test('rejects missing keys, extra keys, and non-finite values to null', () => {
    expect(safeComponents({ perf: 0.5, w: 0.4, policy: -3 })).toBeNull(); // missing dd
    expect(safeComponents({ perf: 0.5, w: 0.4, policy: -3, dd: 1.2, x: 1 })).toBeNull(); // extra
    expect(safeComponents({ perf: NaN, w: 0.4, policy: 0, dd: 0 })).toBeNull();
    expect(safeComponents(null)).toBeNull();
    expect(safeComponents('nope')).toBeNull();
  });
});

describe('buildBreakdown composition', () => {
  test('is a product of perf·w plus policy minus dd (not a sum)', () => {
    const b = buildBreakdown({ perf: 0.5, w: 0.4, policy: 5, dd: 2 });
    // 100*0.5*0.4 = 20 ; + 5 − 2 = 23
    expect(b.performancePoints).toBe(20);
    expect(b.rawUnclamped).toBe(23);
    expect(b.raw).toBe(23);
    expect(b.clamped).toBe(false);
    // A naive flat sum of the four values would be 0.5+0.4+5−2 = 3.9 — not 23.
    expect(b.raw).not.toBe(0.5 + 0.4 + 5 - 2);
  });

  test('marks the clamp when a hard penalty drives the raw below zero', () => {
    const b = buildBreakdown({ perf: 0.6, w: 0.5, policy: -40, dd: 0 });
    // 30 − 40 = −10 → clamped to 0.
    expect(b.rawUnclamped).toBe(-10);
    expect(b.raw).toBe(0);
    expect(b.clamped).toBe(true);
  });

  test('clamps above 100 too', () => {
    const b = buildBreakdown({ perf: 1, w: 1, policy: 50, dd: 0 });
    expect(b.rawUnclamped).toBe(150);
    expect(b.raw).toBe(100);
    expect(b.clamped).toBe(true);
  });

  test('terms carry the multiplicative vs additive roles', () => {
    const roles = Object.fromEntries(
      buildBreakdown({ perf: 0.5, w: 0.4, policy: 1, dd: 1 }).terms.map((t) => [t.key, t.role]),
    );
    expect(roles).toEqual({ perf: 'factor', w: 'factor', policy: 'add', dd: 'subtract' });
  });
});

describe('buildBreakdown proportion bar geometry', () => {
  test('result fill is the clamped raw on a 0–100 axis', () => {
    expect(buildBreakdown({ perf: 0.5, w: 0.4, policy: 5, dd: 2 }).resultFillPct).toBe(23); // raw 23
    expect(buildBreakdown({ perf: 0.6, w: 0.5, policy: -40, dd: 0 }).resultFillPct).toBe(0); // raw 0
    expect(buildBreakdown({ perf: 1, w: 1, policy: 50, dd: 0 }).resultFillPct).toBe(100); // raw 100
  });

  test('contributions are the three additive point-terms, in composition order', () => {
    const b = buildBreakdown({ perf: 0.5, w: 0.4, policy: 5, dd: 2 });
    expect(b.contributions.map((c) => c.key)).toEqual(['performance', 'policy', 'dd']);
    const byKey = Object.fromEntries(b.contributions.map((c) => [c.key, c]));
    // performance = 100·0.5·0.4 = 20 (positive), policy = +5, dd reported as −2.
    expect(byKey.performance).toMatchObject({ points: 20, sign: 'positive', widthPct: 20 });
    expect(byKey.policy).toMatchObject({ points: 5, sign: 'positive', widthPct: 5 });
    expect(byKey.dd).toMatchObject({ points: -2, sign: 'negative', widthPct: 2 });
  });

  test('a negative policy is a negative contribution; exact zero is its own bucket', () => {
    const b = buildBreakdown({ perf: 0, w: 0, policy: -40, dd: 0 });
    const byKey = Object.fromEntries(b.contributions.map((c) => [c.key, c]));
    expect(byKey.performance).toMatchObject({ points: 0, sign: 'zero', widthPct: 0 });
    expect(byKey.policy).toMatchObject({ points: -40, sign: 'negative', widthPct: 40 });
    expect(byKey.dd).toMatchObject({ points: 0, sign: 'zero', widthPct: 0 });
  });

  test('an extreme term saturates the bar width at 100% rather than overflowing', () => {
    // Two stacked hard penalties (−80) and a huge drawdown (−120 points).
    const b = buildBreakdown({ perf: 1, w: 1, policy: -80, dd: 120 });
    const widthOf = (key: string): number =>
      b.contributions.find((c) => c.key === key)?.widthPct ?? Number.NaN;
    expect(widthOf('policy')).toBe(80);
    expect(widthOf('dd')).toBe(100); // |−120|/100 clamps to 1 → 100%.
    for (const c of b.contributions) {
      expect(c.widthPct).toBeGreaterThanOrEqual(0);
      expect(c.widthPct).toBeLessThanOrEqual(100);
    }
    expect(b.resultFillPct).toBeGreaterThanOrEqual(0);
    expect(b.resultFillPct).toBeLessThanOrEqual(100);
  });
});

describe('consistency with the P1.2 scorer', () => {
  const cfg = CONFIG.scoring;
  const cases = [
    { pnl_r: 120, car_r: 1000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
    { pnl_r: -50, car_r: 500, soft: 2, hard: 0, halt: 0, dd_r: 0.4, drain_r: false },
    { pnl_r: 10, car_r: 50, soft: 0, hard: 1, halt: 0, dd_r: 0.1, drain_r: false },
    { pnl_r: 0, car_r: 1, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
  ];

  test('reconstructed raw matches the scorer-stored raw_r', () => {
    for (const inputs of cases) {
      const r = score(inputs, cfg.score_0, cfg);
      const b = buildBreakdown(r.components);
      // raw_r is quantized to 8 dp by the scorer; the breakdown rounds to 6 — compare loosely.
      expect(b.raw).toBeCloseTo(Number(r.raw_r), 4);
    }
  });
});

describe('breakdownFrom', () => {
  test('returns null for an invalid payload and a breakdown for a valid one', () => {
    expect(breakdownFrom({ perf: 0.5 })).toBeNull();
    expect(breakdownFrom({ perf: 0.5, w: 0.4, policy: 0, dd: 0 })?.performancePoints).toBe(20);
  });
});
