import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { score, type ScoringConfig } from '@/lib/scoring/score';
import type { ScoreInputs } from '@/lib/scoring/types';

/**
 * Unit coverage for the pure scoring function (architecture.txt §6.1). ~10%
 * happy-path; the rest are edge cases, invariants, and adversarial inputs:
 * division guard, tanh saturation, clamp boundaries, EWMA, the floor-crash, the
 * anti-Sybil weight, and the "volume/trade-count never enter" invariant.
 */

const C: ScoringConfig = CONFIG.scoring;

/** A clean, zero-violation, zero-drawdown round with the given pnl/car. */
function round(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return { pnl_r: 0, car_r: 10_000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false, ...over };
}

describe('score — happy path', () => {
  test('a clean, profitable round lifts a new agent via EWMA and records components', () => {
    const r = score(round({ pnl_r: 500, car_r: 10_000 }), C.score_0, C);
    expect(Number(r.score_r)).toBeGreaterThan(C.score_0); // moved up from the prior
    expect(Number(r.raw_r)).toBeGreaterThan(Number(r.score_r)); // raw round beats the prior
    expect(r.crashed).toBe(false);
    expect(r.components).toEqual({ perf: 0.88079708, w: 0.90909091, policy: 5, dd: 0 });
    // EWMA: 0.4*raw + 0.6*prior.
    expect(Number(r.score_r)).toBeCloseTo(0.4 * Number(r.raw_r) + 0.6 * C.score_0, 3);
  });
});

describe('score — bounds and codomain', () => {
  test('score_r and raw_r are always within [0,100] across extreme inputs', () => {
    const extremes: ScoreInputs[] = [
      round({ pnl_r: 1e12, car_r: 1 }),
      round({ pnl_r: -1e12, car_r: 1 }),
      round({ pnl_r: 1e12, car_r: 1e12 }),
      round({ soft: 1000 }),
      round({ hard: 1000 }),
      round({ halt: 1000 }),
      round({ dd_r: 100 }),
      round({ pnl_r: 0, car_r: 0 }),
    ];
    for (const inp of extremes) {
      for (const prev of [0, 20, 50, 100]) {
        const r = score(inp, prev, C);
        expect(Number(r.raw_r)).toBeGreaterThanOrEqual(0);
        expect(Number(r.raw_r)).toBeLessThanOrEqual(100);
        expect(Number(r.score_r)).toBeGreaterThanOrEqual(0);
        expect(Number(r.score_r)).toBeLessThanOrEqual(100);
      }
    }
  });

  test('fixed-scale output: raw_r has 8 fraction digits, score_r has 3', () => {
    const r = score(round({ pnl_r: 123.456, car_r: 7777 }), 33, C);
    expect(r.raw_r).toMatch(/^\d+\.\d{8}$/);
    expect(r.score_r).toMatch(/^\d+\.\d{3}$/);
  });
});

describe('score — step 1 & 2: RoC and bounded performance', () => {
  test('the ~0 capital denominator is guarded (no NaN/Infinity)', () => {
    const r = score(round({ pnl_r: 5, car_r: 0 }), C.score_0, C);
    expect(Number.isFinite(Number(r.score_r))).toBe(true);
    // car=0 ⇒ w=0 ⇒ perf·w contributes nothing; only the clean bonus survives.
    expect(r.components.w).toBe(0);
  });

  test('perf saturates in [0,1] for extreme RoC of either sign (tanh)', () => {
    expect(score(round({ pnl_r: 1e9, car_r: 1 }), 50, C).components.perf).toBe(1);
    expect(score(round({ pnl_r: -1e9, car_r: 1 }), 50, C).components.perf).toBe(0);
  });

  test('zero RoC gives a neutral perf of exactly 0.5', () => {
    expect(score(round({ pnl_r: 0, car_r: 10_000 }), 50, C).components.perf).toBe(0.5);
  });
});

describe('score — step 3: capital risk-weight (anti-Sybil)', () => {
  test('w is monotonic increasing in capital-at-risk', () => {
    const w = (car: number) => score(round({ car_r: car }), 50, C).components.w;
    expect(w(1_000)).toBeLessThan(w(10_000));
    expect(w(10_000)).toBeLessThan(w(100_000));
  });

  test('splitting capital across N identities strictly lowers each identity score', () => {
    // Same RoC and clean policy; only the capital differs. A clone holding 1/N
    // of the capital has a strictly smaller w_r, hence a strictly lower score —
    // no Sybil split can outrank the consolidated honest agent.
    const roc = 0.02;
    const whole = score(round({ car_r: 90_000, pnl_r: 90_000 * roc }), C.score_0, C);
    const part = score(round({ car_r: 30_000, pnl_r: 30_000 * roc }), C.score_0, C);
    expect(Number(part.raw_r)).toBeLessThan(Number(whole.raw_r));
    expect(part.components.perf).toBeCloseTo(whole.components.perf, 10); // perf identical
    expect(part.components.w).toBeLessThan(whole.components.w); // weight is what differs
  });
});

describe('score — step 4 & 5: policy and drawdown penalties', () => {
  test('a single hard penalty dominates a strong performance round', () => {
    const clean = score(round({ pnl_r: 5_000, car_r: 50_000 }), 80, C);
    const hard = score(round({ pnl_r: 5_000, car_r: 50_000, hard: 1 }), 80, C);
    expect(Number(hard.raw_r)).toBeLessThan(Number(clean.raw_r));
    expect(hard.components.policy).toBe(-C.p_hard);
    // ...but an ordinary hard does NOT force the floor-crash.
    expect(hard.crashed).toBe(false);
    expect(Number(hard.score_r)).toBeGreaterThan(C.crash_cap);
  });

  test('clean bonus is awarded iff zero hard (soft does not break clean)', () => {
    expect(score(round({ soft: 2 }), 50, C).components.policy).toBe(C.b_clean - 2 * C.p_soft);
    expect(score(round({ hard: 1 }), 50, C).components.policy).toBe(-C.p_hard);
  });

  test('drawdown penalty is zero within tolerance and grows beyond it', () => {
    expect(score(round({ dd_r: C.dd_tol }), 50, C).components.dd).toBe(0);
    expect(score(round({ dd_r: C.dd_tol - 0.01 }), 50, C).components.dd).toBe(0);
    expect(score(round({ dd_r: C.dd_tol + 0.5 }), 50, C).components.dd).toBeGreaterThan(0);
    // Saturates at p_dd for a full-allocation drawdown.
    expect(score(round({ dd_r: 1 + C.dd_tol }), 50, C).components.dd).toBe(C.p_dd);
  });
});

describe('score — step 7: EWMA and the floor-crash', () => {
  test('EWMA blends the round with the prior at weight alpha', () => {
    const r = score(round({ pnl_r: 1_000, car_r: 20_000 }), 70, C);
    expect(Number(r.score_r)).toBeCloseTo(C.alpha * Number(r.raw_r) + (1 - C.alpha) * 70, 3);
  });

  test('halt > 0 collapses the score to crash_cap regardless of a strong prior', () => {
    const r = score(round({ pnl_r: 10_000, car_r: 90_000, halt: 1 }), 99, C);
    expect(r.crashed).toBe(true);
    expect(Number(r.score_r)).toBeLessThanOrEqual(C.crash_cap);
  });

  test('a confirmed drain collapses to crash_cap even with no halt', () => {
    const r = score(round({ car_r: 90_000, hard: 1, drain_r: true }), 99, C);
    expect(r.crashed).toBe(true);
    expect(Number(r.score_r)).toBeLessThanOrEqual(C.crash_cap);
  });

  test('floor-crash uses min(): a score already below crash_cap is not raised to it', () => {
    // EWMA here lands well under crash_cap; min(ewma, crash_cap) keeps the lower.
    const r = score(round({ pnl_r: -1e9, car_r: 1, halt: 1 }), 1, C);
    expect(r.crashed).toBe(true);
    expect(Number(r.score_r)).toBeLessThan(C.crash_cap);
  });

  test('prevScore is clamped into [0,100] before the EWMA', () => {
    const hi = score(round({ pnl_r: 100, car_r: 10_000 }), 1e6, C);
    const at100 = score(round({ pnl_r: 100, car_r: 10_000 }), 100, C);
    expect(hi.score_r).toBe(at100.score_r);
  });
});

describe('score — anti-wash: volume / trade-count never enter', () => {
  test('only car_r and pnl_r carry exposure; ScoreInputs has no count/volume field', () => {
    // Structural guarantee: the only exposure inputs are car_r and pnl_r. A wash
    // farmer churning many trades at the same net car/pnl produces an identical
    // score — there is nowhere for trade count or volume to raise it.
    const a = score(round({ pnl_r: 10, car_r: 5_000 }), 40, C);
    const b = score(round({ pnl_r: 10, car_r: 5_000 }), 40, C);
    expect(b).toEqual(a);
    const keys = Object.keys(round()).sort();
    expect(keys).toEqual(['car_r', 'dd_r', 'drain_r', 'halt', 'hard', 'pnl_r', 'soft']);
  });
});

describe('score — determinism', () => {
  test('the same input yields a byte-identical result across repeated calls', () => {
    const inp = round({ pnl_r: 777.123, car_r: 33_333, soft: 1, dd_r: 0.4 });
    const first = score(inp, 42.5, C);
    for (let i = 0; i < 50; i += 1) {
      expect(score(inp, 42.5, C)).toEqual(first);
    }
  });
});

describe('score — invalid inputs are rejected deterministically', () => {
  const bad: [string, ScoreInputs][] = [
    ['NaN pnl', round({ pnl_r: Number.NaN })],
    ['Infinity pnl', round({ pnl_r: Number.POSITIVE_INFINITY })],
    ['NaN car', round({ car_r: Number.NaN })],
    ['negative car', round({ car_r: -1 })],
    ['negative dd', round({ dd_r: -0.01 })],
    ['NaN dd', round({ dd_r: Number.NaN })],
    ['fractional soft', round({ soft: 1.5 })],
    ['negative hard', round({ hard: -1 })],
    ['fractional halt', round({ halt: 0.5 })],
  ];
  for (const [name, inp] of bad) {
    test(`${name} throws RangeError`, () => {
      expect(() => score(inp, C.score_0, C)).toThrow(RangeError);
    });
  }

  test('a non-finite prevScore throws', () => {
    expect(() => score(round(), Number.NaN, C)).toThrow(RangeError);
  });
});

describe('score — monotonicity property', () => {
  test('with fixed car and clean policy, score is non-decreasing in pnl', () => {
    let prevRaw = -1;
    for (const pnl of [-5_000, -1_000, 0, 1_000, 5_000, 50_000]) {
      const raw = Number(score(round({ pnl_r: pnl, car_r: 20_000 }), 50, C).raw_r);
      expect(raw).toBeGreaterThanOrEqual(prevRaw);
      prevRaw = raw;
    }
  });
});
