import type { VectorConfig } from '@/lib/config/constants';

import type { ScoreComponents, ScoreInputs, ScoreResult } from './types';

/**
 * Pure, deterministic AgentScore computation — architecture.txt §6.1.
 *
 * Given one round's aggregated {@link ScoreInputs}, the previous EWMA score, and
 * the seeded scoring config, {@link score} returns the round's `raw_r`, the new
 * EWMA `score_r ∈ [0, 100]`, and the `{ perf, w, policy, dd }` components — with
 * no I/O, no clock, and no randomness, so a fixed input yields a bit-identical
 * result on every run (the determinism mandate, §6.5).
 *
 * ## Scale reconciliation (read before changing the constants)
 *
 * §6.1 writes the round score as `raw_r = 100·clamp(perf·w + policy − dd, 0, 1)`,
 * but every penalty/bonus constant in `CONFIG.scoring` is on a **0–100 point**
 * scale (`b_clean=5`, `p_soft=3`, `p_hard=40`, `p_halt=60`, `p_dd=20`) — as are
 * `score_0`, `crash_cap` and the router's `s_min`. Mixing a `[0,1]` term
 * (`perf·w`) with point-scale penalties inside a `[0,1]` clamp is only coherent
 * if the penalties are read as points, i.e.
 *
 *     raw_r = clamp(100·perf·w + policy_pts − dd_pts, 0, 100)
 *           ≡ 100·clamp(perf·w + policy_pts/100 − dd_pts/100, 0, 1)
 *
 * which is the form implemented here. This is the only reading consistent with
 * the spec's own §6.1 note that an ordinary (non-drain) `hard` is a *dominant
 * penalty in `policy_r`* — **not** a forced collapse: under the literal `[0,1]`
 * clamp a single `hard` (−40) would drive `raw_r` to 0, i.e. *below* the
 * `crash_cap` of 7, erasing the deliberate distinction between an ordinary
 * `hard` and a floor-crash (`halt`/drain). Point-scale keeps a hard as a large
 * dominating subtraction while reserving collapse-to-`crash_cap` for `halt`/
 * drain, and it is what makes the anti-Sybil weight `w_r` actually bite (a
 * clean low-capital agent does not saturate to 100). See `docs/scoring.md`.
 */

/** The scoring slice of the seeded config (§6.1). */
export type ScoringConfig = VectorConfig['scoring'];

/** Clamp `x` into the closed interval `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Quantize a finite number to a fixed-scale canonical decimal string (the
 * `numeric(p, s)` column scale). `toFixed` is deterministic on a fixed engine
 * and yields the exact stored representation, so a golden row is reproducible.
 * `+0` is normalized so a clamped-to-zero value never serializes as `-0...`.
 */
function quantize(value: number, scale: number): string {
  return (value + 0).toFixed(scale);
}

/** Round a component to a stable precision so `components_json` carries no float drift. */
function round8(value: number): number {
  return Number((value + 0).toFixed(8));
}

/** Reject a non-finite or negative-when-forbidden numeric input deterministically. */
function requireFinite(value: number, label: string, { nonNegative = false } = {}): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`score(): ${label} must be finite, got ${value}`);
  }
  if (nonNegative && value < 0) {
    throw new RangeError(`score(): ${label} must be >= 0, got ${value}`);
  }
}

/** Reject a count that is not a non-negative integer. */
function requireCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`score(): ${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Compute one round's AgentScore (§6.1 steps 1–7).
 *
 * @param inputs    Aggregated round facts. Invalid (NaN/∞, negative CaR,
 *                  fractional/negative counts) inputs throw {@link RangeError}.
 * @param prevScore Previous EWMA score; a brand-new agent passes `config.score_0`.
 *                  Must be finite; it is clamped into `[0, 100]` defensively.
 * @param config    Seeded scoring constants (`CONFIG.scoring`).
 */
export function score(inputs: ScoreInputs, prevScore: number, config: ScoringConfig): ScoreResult {
  const { pnl_r, car_r, soft, hard, halt, dd_r, drain_r } = inputs;

  // 0 — Validation. Every untrusted input maps to a deterministic outcome:
  // a value, or a thrown RangeError. No NaN/∞ ever propagates to the output.
  requireFinite(pnl_r, 'pnl_r');
  requireFinite(car_r, 'car_r', { nonNegative: true });
  requireFinite(dd_r, 'dd_r', { nonNegative: true });
  requireCount(soft, 'soft');
  requireCount(hard, 'hard');
  requireCount(halt, 'halt');
  requireFinite(prevScore, 'prevScore');

  const {
    k_perf,
    s_roc,
    c_floor,
    b_clean,
    p_soft,
    p_hard,
    p_halt,
    p_dd,
    dd_tol,
    epsilon,
    alpha,
    crash_cap,
  } = config;

  // 1 — Return on capital-at-risk. `max(car, ε)` guards the ~0 denominator.
  const roc_r = pnl_r / Math.max(car_r, epsilon);

  // 2 — Bounded performance term. `tanh` saturates extreme RoC so a single
  // lucky/blow-up round cannot dominate; `clamp` is belt-and-suspenders.
  const perf = clamp(0.5 + k_perf * Math.tanh(roc_r / s_roc), 0, 1);

  // 3 — Capital risk-weight. Concave, in `[0, 1)`; this is the *only* place
  // capital exposure enters, which is what resists Sybil and wash trading.
  const w = car_r / (car_r + c_floor);

  // 4 — Policy term (points). A clean round (zero `hard`) earns `b_clean`;
  // every violation subtracts its severity-weighted penalty. `p_hard`/`p_halt`
  // dominate any positive performance by construction.
  const clean = hard === 0;
  const policy = (clean ? b_clean : 0) - p_soft * soft - p_hard * hard - p_halt * halt;

  // 5 — Drawdown penalty (points), applied only beyond the tolerance band.
  const dd = p_dd * clamp(dd_r - dd_tol, 0, 1);

  // 6 — Round score, point-scale and clamped to the bounded codomain.
  const raw = clamp(100 * perf * w + policy - dd, 0, 100);

  // 7 — EWMA over history, then the floor-crash. A `halt` or a confirmed drain
  // attempt caps the score at `crash_cap` *after* smoothing — catastrophe
  // collapses reputation regardless of a strong prior or a strong raw round.
  const prior = clamp(prevScore, 0, 100);
  const ewma = alpha * raw + (1 - alpha) * prior;
  const crashed = halt > 0 || drain_r;
  const scoreR = clamp(crashed ? Math.min(ewma, crash_cap) : ewma, 0, 100);

  const components: ScoreComponents = {
    perf: round8(perf),
    w: round8(w),
    policy: round8(policy),
    dd: round8(dd),
  };

  return {
    raw_r: quantize(raw, 8),
    score_r: quantize(scoreR, 3),
    crashed,
    components,
  };
}
