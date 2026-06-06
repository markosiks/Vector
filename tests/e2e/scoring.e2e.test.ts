import { describe, expect, test } from 'bun:test';

import { CONFIG } from '@/lib/config/constants';
import { score, type ScoringConfig } from '@/lib/scoring/score';
import type { ScoreInputs } from '@/lib/scoring/types';

/**
 * Hard end-to-end scenarios for the scoring engine (§11): long alternating
 * catastrophe/recovery histories, simultaneous extremes, attempts to "buy back"
 * a crash with activity, order-of-magnitude capital jumps, `alpha` at its open
 * boundaries, and N-fold reproducibility. The bar: every score is deterministic,
 * in `[0, 100]`, a single hard/halt dominates, a halt/drain collapses to
 * `crash_cap`, and trade volume/count never move the number.
 */

const C = CONFIG.scoring;

function inp(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return { pnl_r: 0, car_r: 10_000, soft: 0, hard: 0, halt: 0, dd_r: 0, drain_r: false, ...over };
}

/** Replay an EWMA chain from `score_0`, returning each round's `score_r`. */
function chain(rounds: ScoreInputs[], config: ScoringConfig = C): number[] {
  let prev = config.score_0;
  const out: number[] = [];
  for (const round of rounds) {
    const r = score(round, prev, config);
    prev = Number(r.score_r);
    out.push(prev);
  }
  return out;
}

describe('scoring e2e — catastrophe and recovery over a long history', () => {
  test('a halt collapses to crash_cap, then clean profitable rounds recover via EWMA', () => {
    const history: ScoreInputs[] = [
      inp({ pnl_r: 1_000, car_r: 50_000 }),
      inp({ pnl_r: 1_200, car_r: 50_000 }),
      inp({ pnl_r: 1_500, car_r: 50_000, halt: 1 }), // catastrophe
      inp({ pnl_r: 1_000, car_r: 50_000 }), // recovery begins
      inp({ pnl_r: 1_000, car_r: 50_000 }),
      inp({ pnl_r: 1_000, car_r: 50_000 }),
    ];
    const scores = chain(history);
    expect(scores[2]).toBeLessThanOrEqual(C.crash_cap); // crashed
    expect(scores[3]!).toBeGreaterThan(scores[2]!); // recovering
    expect(scores[5]!).toBeGreaterThan(scores[3]!); // and climbing
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  test('alternating crash/clean never escapes [0,100] and re-crashes each catastrophe', () => {
    const rounds: ScoreInputs[] = [];
    for (let i = 0; i < 40; i += 1) {
      rounds.push(
        i % 2 === 0
          ? inp({ pnl_r: 2_000, car_r: 60_000 })
          : inp({ car_r: 60_000, drain_r: true, hard: 1 }),
      );
    }
    const scores = chain(rounds);
    scores.forEach((s, i) => {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      if (i % 2 === 1) expect(s).toBeLessThanOrEqual(C.crash_cap); // every drain round crashes
    });
  });
});

describe('scoring e2e — a crash cannot be bought back with activity', () => {
  test('once halted, more "trading" (same car/pnl, no policy change) does not lift past a clean run', () => {
    // Volume/trade-count are not inputs; the only lever is car/pnl/policy. A
    // farmer cannot inflate the score by churning — identical car/pnl give
    // identical scores, and the catastrophe round still collapses.
    const halted = score(inp({ pnl_r: 9_999, car_r: 90_000, halt: 1 }), 99, C);
    const churned = score(inp({ pnl_r: 9_999, car_r: 90_000, halt: 1 }), 99, C);
    expect(churned).toEqual(halted);
    expect(Number(halted.score_r)).toBeLessThanOrEqual(C.crash_cap);
  });
});

describe('scoring e2e — simultaneous extremes and capital jumps', () => {
  test('all inputs at extremes at once stays finite and bounded', () => {
    const r = score(
      { pnl_r: 1e12, car_r: 1e12, soft: 1000, hard: 1000, halt: 1000, dd_r: 1000, drain_r: true },
      100,
      C,
    );
    expect(Number.isFinite(Number(r.score_r))).toBe(true);
    expect(Number(r.score_r)).toBeLessThanOrEqual(C.crash_cap); // halt+drain ⇒ crash
    expect(Number(r.raw_r)).toBeGreaterThanOrEqual(0);
    expect(Number(r.raw_r)).toBeLessThanOrEqual(100);
  });

  test('capital jumping orders of magnitude only moves the weight, never breaks bounds', () => {
    let prev = 50;
    for (const car of [1, 1e3, 1e6, 1e9, 1, 1e9]) {
      const r = score(inp({ pnl_r: car * 0.02, car_r: car }), prev, C);
      expect(Number(r.score_r)).toBeGreaterThanOrEqual(0);
      expect(Number(r.score_r)).toBeLessThanOrEqual(100);
      prev = Number(r.score_r);
    }
  });
});

describe('scoring e2e — alpha at its open-interval boundaries', () => {
  test('alpha→0+ pins the score near the prior; alpha→1- tracks the raw round', () => {
    const round = inp({ pnl_r: 5_000, car_r: 80_000 });
    const slow: ScoringConfig = { ...C, alpha: 1e-6 };
    const fast: ScoringConfig = { ...C, alpha: 1 - 1e-6 };
    const prior = 30;
    const slowR = score(round, prior, slow);
    const fastR = score(round, prior, fast);
    expect(Number(slowR.score_r)).toBeCloseTo(prior, 2); // barely moves
    expect(Number(fastR.score_r)).toBeCloseTo(Number(fastR.raw_r), 2); // tracks raw
  });
});

describe('scoring e2e — reproducibility', () => {
  test('replaying the same 25-round scenario N times yields identical score paths', () => {
    const rounds: ScoreInputs[] = Array.from({ length: 25 }, (_, i) =>
      inp({
        pnl_r: (i % 7) * 500 - 1_000,
        car_r: 1_000 * (i + 1),
        soft: i % 3,
        hard: i % 11 === 0 ? 1 : 0,
        halt: i % 17 === 0 ? 1 : 0,
        dd_r: (i % 5) * 0.1,
        drain_r: i % 13 === 0,
      }),
    );
    const first = chain(rounds);
    for (let n = 0; n < 20; n += 1) {
      expect(chain(rounds)).toEqual(first);
    }
  });
});
