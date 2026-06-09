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

/** The sign of a point-scale contribution, for colour/role in the proportion bar. */
export type ContributionSign = 'positive' | 'negative' | 'zero';

/**
 * One additive **point-scale** contribution to `raw_r`, with its proportional
 * bar geometry. Unlike {@link BreakdownTerm} (the four raw components), these are
 * the three terms that actually *add up* on the 0–100 points axis:
 * `performance` (the `100·perf·w` product), `policy`, and `dd` (always
 * subtracted). `widthPct` is the term's magnitude as a percentage of the score
 * codomain (`|points| / 100`, clamped to `[0,100]`), so a render can size a bar
 * directly and an extreme term (e.g. several stacked `hard`s) saturates the bar
 * rather than overflowing it.
 */
export interface BreakdownContribution {
  readonly key: 'performance' | 'policy' | 'dd';
  readonly label: string;
  /** Signed contribution in score points (`dd` is reported as `−dd`). */
  readonly points: number;
  readonly sign: ContributionSign;
  /** `clamp(|points| / 100, 0, 1) · 100` — proportional bar width, in `[0,100]`. */
  readonly widthPct: number;
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
  /** `clamp(raw / 100, 0, 1) · 100` — the net result as a percentage of the bar. */
  readonly resultFillPct: number;
  /**
   * The three additive point-scale contributions (`performance`, `policy`,
   * `dd`) with proportional bar geometry, for the visual breakdown. Ordered as
   * they compose `raw`.
   */
  readonly contributions: readonly BreakdownContribution[];
}

/** Sign bucket for a signed point contribution (exact-zero is its own bucket). */
function signOf(points: number): ContributionSign {
  if (points > 0) return 'positive';
  if (points < 0) return 'negative';
  return 'zero';
}

/** A point contribution's proportional width on the 0–100 score axis. */
function widthPctOf(points: number): number {
  return round6(clamp(Math.abs(points) / 100, 0, 1) * 100);
}

/** Build one {@link BreakdownContribution} from a signed point value. */
function contribution(
  key: BreakdownContribution['key'],
  label: string,
  points: number,
): BreakdownContribution {
  const p = round6(points);
  return { key, label, points: p, sign: signOf(p), widthPct: widthPctOf(p) };
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
    resultFillPct: round6(clamp(raw / 100, 0, 1) * 100),
    contributions: [
      contribution('performance', 'Performance × weight', performancePoints),
      contribution('policy', 'Policy', c.policy),
      // Drawdown always subtracts, so it is reported as a negative contribution.
      contribution('dd', 'Drawdown', -c.dd),
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
