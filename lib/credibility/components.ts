import { z } from 'zod';

import { scoreComponents } from '@/lib/db/schema';

/** The validated `{ perf, w, policy, dd }` shape persisted in `components_json`. */
export type ScoreComponents = z.infer<typeof scoreComponents>;

/**
 * Score-breakdown model for the Agent-detail screen (P2.3).
 *
 * `scores.components_json` carries the four explainability terms the scorer
 * persisted — `{ perf, w, policy, dd }` — and the round score is **not** their
 * sum: it is the §6.1 composition
 *
 *     raw_r = clamp(100·perf·w + policy − dd, 0, 100)
 *           ≡ 100·clamp(perf·w + policy/100 − dd/100, 0, 1)
 *
 * where `perf` and `w` are `[0, 1]` factors that *multiply*, and `policy`/`dd`
 * are point-scale (0–100) terms that add/subtract (see `lib/scoring/score.ts`).
 * This module reconstructs that composition as plain data so the UI can render
 * the formula explicitly — performance×weight as a product, policy and drawdown
 * as signed point adjustments — instead of implying a flat sum, and so a test
 * can assert the reconstructed `raw_r` matches the value P1.2 stored.
 *
 * All inputs are treated as untrusted: a fuzzed or partial DTO is validated by
 * {@link safeComponents} and rejected to `null` rather than crashing a render.
 */

/** Clamp `x` into `[lo, hi]`; `NaN` collapses to `lo` so it never escapes. */
function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Round to 6 places to strip float noise from a display number (not money). */
function round6(x: number): number {
  return Number((x + 0).toFixed(6));
}

/**
 * Validate an unknown `components` payload against the canonical schema. Returns
 * the typed components, or `null` for anything malformed (missing/extra keys,
 * non-finite values) so the caller renders an empty state instead of throwing.
 */
export function safeComponents(input: unknown): ScoreComponents | null {
  const parsed = scoreComponents.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** The role of a term in the `100·perf·w + policy − dd` composition. */
export type TermRole = 'factor' | 'add' | 'subtract';

/** One line of the breakdown the UI renders. */
export interface BreakdownTerm {
  readonly key: 'perf' | 'w' | 'policy' | 'dd';
  readonly label: string;
  /** The raw component value (`perf`/`w` are `[0,1]`; `policy`/`dd` are points). */
  readonly value: number;
  readonly role: TermRole;
}

/** The fully-reconstructed §6.1 composition for one round's components. */
export interface ScoreBreakdown {
  readonly perf: number;
  readonly w: number;
  readonly policy: number;
  readonly dd: number;
  /** `100 · perf · w` — the weighted-performance base, in points. */
  readonly performancePoints: number;
  /** `performancePoints + policy − dd`, before the `[0,100]` clamp. */
  readonly rawUnclamped: number;
  /** `clamp(rawUnclamped, 0, 100)` — the reconstructed `raw_r`. */
  readonly raw: number;
  /** `true` when the clamp actually bound the value (raw differs from unclamped). */
  readonly clamped: boolean;
  /** The ordered terms, for rendering the formula as `100·perf·w + policy − dd`. */
  readonly terms: readonly BreakdownTerm[];
}

/**
 * Reconstruct the §6.1 score composition from validated components. Pure and
 * total: every finite-component input yields a breakdown; the multiplicative and
 * additive roles are explicit so the UI never renders the terms as a flat sum.
 */
export function buildBreakdown(c: ScoreComponents): ScoreBreakdown {
  const performancePoints = round6(100 * c.perf * c.w);
  const rawUnclamped = round6(performancePoints + c.policy - c.dd);
  const raw = round6(clamp(rawUnclamped, 0, 100));
  return {
    perf: c.perf,
    w: c.w,
    policy: c.policy,
    dd: c.dd,
    performancePoints,
    rawUnclamped,
    raw,
    clamped: raw !== rawUnclamped,
    terms: [
      { key: 'perf', label: 'Performance', value: c.perf, role: 'factor' },
      { key: 'w', label: 'Capital weight', value: c.w, role: 'factor' },
      { key: 'policy', label: 'Policy', value: c.policy, role: 'add' },
      { key: 'dd', label: 'Drawdown', value: c.dd, role: 'subtract' },
    ],
  };
}

/**
 * Convenience: validate then reconstruct, returning `null` for an invalid or
 * absent payload. The agent-detail breakdown panel keys off exactly this.
 */
export function breakdownFrom(input: unknown): ScoreBreakdown | null {
  const c = safeComponents(input);
  return c === null ? null : buildBreakdown(c);
}
