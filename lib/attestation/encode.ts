/**
 * Pure ERC-8004 feedback encoding for the attestation pipeline (P1.8).
 *
 * One settle writes exactly one feedback record per agent per round. This module
 * is the deterministic, network-free core that turns a round's *already-computed*
 * facts into the on-chain payload fields:
 *
 * - `value`         — the **absolute** AgentScore, rounded to an integer `0–100`;
 * - `valueDecimals` — fixed `0` (we anchor the absolute score, never a delta, so
 *                     on-chain filtering is unambiguous);
 * - `tag1`          — the round id (`round_id`);
 * - `tag2`          — the round's `outcome_class` (`clean` / `violation` / `halt`).
 *
 * It has no I/O, no clock and no randomness, so a fixed input yields a
 * bit-identical payload on every run — the same determinism mandate the scorer
 * holds (§6.5). Every untrusted input maps to a deterministic outcome: a value,
 * or a thrown {@link AttestationEncodeError}; nothing else escapes.
 */

/** The three mutually-exclusive round outcome classes written to `tag2`. */
export const OUTCOME_CLASS = ['clean', 'violation', 'halt'] as const;
export type OutcomeClass = (typeof OUTCOME_CLASS)[number];

/** Inclusive bounds of a Solidity `int128` (the registry `value` type). */
export const INT128_MIN = -(1n << 127n);
export const INT128_MAX = (1n << 127n) - 1n;

/** The fixed `valueDecimals` for every Vector attestation: an integer score. */
export const VALUE_DECIMALS = 0;

/** Lowest / highest integer score the `value` field may carry. */
const SCORE_MIN = 0;
const SCORE_MAX = 100;

/** Defensive upper bound on a tag string (rejects pathological round ids). */
const MAX_TAG_LEN = 256;

/** Thrown on any invalid encode input. Value-free where the input is a secret. */
export class AttestationEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationEncodeError';
  }
}

/** The per-round violation facts {@link deriveOutcomeClass} reduces. */
export interface OutcomeClassInputs {
  /** Count of `soft` policy violations this round (non-negative integer). */
  readonly soft: number;
  /** Count of `hard` policy violations this round (non-negative integer). */
  readonly hard: number;
  /** Count of `halt` policy violations this round (non-negative integer). */
  readonly halt: number;
  /**
   * Whether the round floor-crashed: a `halt` or a *confirmed drain attempt*
   * (referee rule #3). This is the scorer's `crashed` flag — `halt > 0 || drain`.
   */
  readonly crashed: boolean;
}

/** The fully-encoded ERC-8004 feedback payload fields. */
export interface EncodedFeedback {
  /** Absolute AgentScore rounded to an integer `0–100`, as a Solidity `int128`. */
  readonly value: bigint;
  /** Always {@link VALUE_DECIMALS} (`0`). */
  readonly valueDecimals: number;
  /** `tag1` — the round id. */
  readonly tag1: string;
  /** `tag2` — the round's {@link OutcomeClass}. */
  readonly tag2: string;
}

/** Clamp `x` into the closed interval `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Reject a count that is not a non-negative integer. */
function requireCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AttestationEncodeError(`${label} must be a non-negative integer`);
  }
}

/**
 * Encode an AgentScore into the on-chain `value` (`int128`, `valueDecimals = 0`).
 *
 * The score is the bounded `[0, 100]` reputation the scorer persists (a
 * fixed-scale decimal string such as `"73.500"`, or a number). It is rounded to
 * the nearest integer and clamped to `[0, 100]` so a value outside the score
 * codomain can never be written on-chain — `round(x)` with `clamp` is total over
 * every finite input. A non-finite score is a deterministic rejection, never a
 * silent `0` or an ABI panic.
 *
 * `Math.round` rounds half **up** (`0.5 → 1`); this is the single, documented
 * tie rule so a golden record is reproducible.
 */
export function encodeScoreValue(score: string | number): bigint {
  const n = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(n)) {
    throw new AttestationEncodeError('score must be a finite number');
  }
  const rounded = Math.round(clamp(n, SCORE_MIN, SCORE_MAX));
  const value = BigInt(rounded);
  // 0–100 is trivially inside int128; assert the invariant so the encoder stays
  // correct if the score codomain ever widens, rather than silently overflowing.
  if (value < INT128_MIN || value > INT128_MAX) {
    throw new AttestationEncodeError('encoded value out of int128 range');
  }
  return value;
}

/**
 * Derive the round's `outcome_class` from its violation facts, exactly per the
 * spec's precedence (§6.4):
 *
 *  1. `halt`      — if `halt > 0` **or** the round floor-crashed (`crashed`,
 *                   i.e. a confirmed drain). The catastrophe class dominates.
 *  2. `violation` — else if there was any `hard` or `soft` violation.
 *  3. `clean`     — otherwise.
 *
 * `crashed` already folds in `halt > 0 || drain`, so a drain with no explicit
 * `halt` event still classifies as `halt` — the on-chain class matches the
 * scorer's floor-crash, never under-reporting a catastrophe.
 */
export function deriveOutcomeClass(inputs: OutcomeClassInputs): OutcomeClass {
  requireCount(inputs.soft, 'soft');
  requireCount(inputs.hard, 'hard');
  requireCount(inputs.halt, 'halt');
  if (inputs.halt > 0 || inputs.crashed) {
    return 'halt';
  }
  if (inputs.hard > 0 || inputs.soft > 0) {
    return 'violation';
  }
  return 'clean';
}

/** Validate a `round_id` tag argument: a non-empty, length-bounded string. */
function requireRoundId(roundId: string): string {
  if (typeof roundId !== 'string' || roundId.length === 0) {
    throw new AttestationEncodeError('round_id must be a non-empty string');
  }
  if (roundId.length > MAX_TAG_LEN) {
    throw new AttestationEncodeError('round_id exceeds the maximum tag length');
  }
  return roundId;
}

/**
 * Encode one round's facts into the complete ERC-8004 feedback payload fields
 * (`value`, `valueDecimals`, `tag1`, `tag2`). Pure and total: a deterministic
 * payload, or a thrown {@link AttestationEncodeError}.
 */
export function encodeFeedback(args: {
  readonly scoreR: string | number;
  readonly roundId: string;
  readonly outcomeClass: OutcomeClass;
}): EncodedFeedback {
  if (!OUTCOME_CLASS.includes(args.outcomeClass)) {
    throw new AttestationEncodeError('outcomeClass must be a known OutcomeClass');
  }
  return {
    value: encodeScoreValue(args.scoreR),
    valueDecimals: VALUE_DECIMALS,
    tag1: requireRoundId(args.roundId),
    tag2: args.outcomeClass,
  };
}
