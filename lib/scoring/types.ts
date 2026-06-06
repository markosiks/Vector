/**
 * Scoring-engine types — architecture.txt §6.1.
 *
 * The score is a bounded, path-dependent reputation in `[0, 100]` that rewards
 * return on capital-at-risk, punishes policy violations asymmetrically, resists
 * Sybil/wash by weighting on capital-at-risk (never trade count or volume), and
 * collapses instantly on a catastrophe (a `halt` or a confirmed drain attempt).
 */

/**
 * Per-agent, per-round scoring inputs. These are the *aggregated* facts of one
 * round, already reduced from the round's `outcomes` and `policy_events`
 * (see {@link deriveScoreInputs}); {@link score} is a pure function of them.
 *
 * Anti-Sybil / anti-wash invariant: neither trade count nor traded volume
 * appears here. Capital exposure enters *only* through {@link car_r}.
 */
export interface ScoreInputs {
  /** Round PnL (realized + marked). May be negative. Must be finite. */
  readonly pnl_r: number;
  /**
   * Capital-at-risk: time-weighted `|notional|` for the round. The single
   * exposure signal. Must be finite and `>= 0`. Not a trade count, not volume.
   */
  readonly car_r: number;
  /** Count of `soft` policy violations this round. Non-negative integer. */
  readonly soft: number;
  /** Count of `hard` policy violations this round. Non-negative integer. */
  readonly hard: number;
  /** Count of `halt` policy violations this round. Non-negative integer. */
  readonly halt: number;
  /**
   * Max drawdown for the round as a fraction of allocation, clamped to `[0, 1]`.
   * Must be finite and `>= 0`; values `> 1` are tolerated and saturate the
   * drawdown penalty.
   */
  readonly dd_r: number;
  /**
   * Whether the round triggered referee rule #3 (fresh-wallet / transfer
   * block) — a *confirmed drain attempt*. Distinguishes a drain `hard` from an
   * ordinary `hard` (e.g. a whitelist REJECT). Only this flag (or `halt > 0`)
   * forces the floor-crash; an ordinary `hard` does not.
   */
  readonly drain_r: boolean;
}

/**
 * The four explainability components written to `scores.components_json`.
 *
 * These keys are a **contract**: downstream readers (P2.3 attestations, P3.2
 * UI) key on exactly `{ perf, w, policy, dd }`. Do not rename or add keys here
 * without updating those consumers.
 *
 * - `perf` — bounded performance term `perf_r ∈ [0, 1]`.
 * - `w`    — capital risk-weight `w_r ∈ [0, 1)`.
 * - `policy` — policy term in score points (bonus minus weighted penalties).
 * - `dd`   — drawdown penalty in score points (`>= 0`).
 */
export interface ScoreComponents {
  readonly perf: number;
  readonly w: number;
  readonly policy: number;
  readonly dd: number;
}

/**
 * Result of {@link score}. `raw_r` and `score_r` are canonical fixed-scale
 * decimal *strings* (quantized to their `numeric` column scale) so the stored
 * value is bit-for-bit reproducible and never carries float drift; `components`
 * are the breakdown for `components_json`.
 */
export interface ScoreResult {
  /** Pre-EWMA round score, clamped to `[0, 100]`, as a fixed-scale string. */
  readonly raw_r: string;
  /** EWMA-smoothed AgentScore `∈ [0, 100]` after floor-crash, fixed-scale string. */
  readonly score_r: string;
  /** Whether the floor-crash fired (`halt > 0` or `drain_r`). Drives gating. */
  readonly crashed: boolean;
  readonly components: ScoreComponents;
}
