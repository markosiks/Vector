import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { score } from '@/lib/scoring/score';
import type { ScoreInputs } from '@/lib/scoring/types';

/**
 * Property fuzzing for the scoring function (§10). A deterministic PRNG drives
 * thousands of wide-range inputs (including extremes) so the suite is itself
 * reproducible. Invariants checked on every draw:
 *  - `score_r, raw_r ∈ [0, 100]`, both finite (never NaN/∞);
 *  - `halt > 0 ∨ drain_r ⇒ score_r ≤ crash_cap` (floor-crash);
 *  - an ordinary (non-drain, no-halt) `hard` never forces `crash_cap`;
 *  - determinism: the same draw scores identically twice.
 * Plus a property: with fixed car and clean policy, score is non-decreasing in pnl.
 */

const C = CONFIG.scoring;

/** Deterministic mulberry32 PRNG — seeded so the fuzz run is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map a uniform [0,1) to a signed, heavy-tailed magnitude spanning ~[-1e9, 1e9]. */
function spread(u: number): number {
  const sign = u < 0.5 ? -1 : 1;
  const m = Math.abs(u - 0.5) * 2; // [0,1)
  return sign * 10 ** (m * 9); // up to 1e9
}

describe('scoring fuzz — invariants hold on wide-range inputs', () => {
  test('5000 draws stay bounded, finite, and respect the floor-crash', () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 5000; i += 1) {
      const inputs: ScoreInputs = {
        pnl_r: spread(r()),
        car_r: 10 ** (r() * 9), // [1, 1e9), always >= 0
        soft: Math.floor(r() * 5),
        hard: Math.floor(r() * 4),
        halt: r() < 0.1 ? Math.floor(r() * 3) : 0,
        dd_r: r() * 1.5, // includes > 1 (saturating) territory
        drain_r: r() < 0.1,
      };
      const prev = r() * 100;
      const out = score(inputs, prev, C);

      const sr = Number(out.score_r);
      const rr = Number(out.raw_r);
      expect(Number.isFinite(sr) && Number.isFinite(rr)).toBe(true);
      expect(sr).toBeGreaterThanOrEqual(0);
      expect(sr).toBeLessThanOrEqual(100);
      expect(rr).toBeGreaterThanOrEqual(0);
      expect(rr).toBeLessThanOrEqual(100);

      if (inputs.halt > 0 || inputs.drain_r) {
        expect(out.crashed).toBe(true);
        expect(sr).toBeLessThanOrEqual(C.crash_cap);
      } else {
        // A non-drain, no-halt round never floor-crashes, even with hard hits.
        expect(out.crashed).toBe(false);
      }

      // Determinism: identical draw scores identically.
      expect(score(inputs, prev, C)).toEqual(out);
    }
  });
});

describe('scoring fuzz — monotonicity in pnl', () => {
  test('1000 random (car, prev) pairs: raw_r is non-decreasing as pnl rises', () => {
    const r = rng(0x5eed);
    const ladder = [-1e8, -1e6, -1e4, -100, 0, 100, 1e4, 1e6, 1e8];
    for (let i = 0; i < 1000; i += 1) {
      const car = 10 ** (1 + r() * 8);
      const prev = r() * 100;
      let last = -1;
      for (const pnl of ladder) {
        const raw = Number(
          score(
            { pnl_r: pnl, car_r: car, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false },
            prev,
            C,
          ).raw_r,
        );
        expect(raw).toBeGreaterThanOrEqual(last);
        last = raw;
      }
    }
  });
});
