import type { VectorConfig } from '@/lib/config/constants.schema';

/**
 * Deterministic tick scheduler for the demo spine (architecture.txt §6.5, §7.3).
 *
 * The replay arc advances in fixed **ticks**: `tick_rate_ms` apart, grouped into
 * rounds of `ticks_per_round`. This module computes the *structure* of that arc
 * — which tick belongs to which round, where a round settles, and the wall-clock
 * offset of each tick — as a pure function of the seeded timing config. It reads
 * no system clock and owns no randomness, so the plan is bit-identical on every
 * run; the only thing the live runner adds is the *pacing* (sleeping between
 * ticks), and pacing never feeds back into the arc's logic or its persisted
 * state. That separation is what lets the same seed produce a byte-identical arc
 * whether it runs in 90 real seconds or instantly in a test.
 *
 * Time enters the deterministic logic only as a fixed **virtual clock**: a tick
 * maps to `base_time_ms + index * tick_rate_ms`. Intents are stamped and
 * validated against this virtual clock (not `Date.now()`), so their signed bytes
 * — and therefore their hashes — are reproducible across runs and hosts.
 */

/** The timing slice the scheduler reads (`CONFIG.timing`). */
export type SchedulerTiming = Pick<VectorConfig['timing'], 'tick_rate_ms' | 'ticks_per_round'>;

/**
 * One scheduled tick. `roundIndex`/`tickInRound` locate it in the round grid;
 * `isRoundSettle` marks the final tick of a round, where scores settle and
 * capital re-routes (§5.2 step 7). `startOffsetMs` is the tick's offset from the
 * arc start (`index * tick_rate_ms`), the basis for both pacing and the virtual
 * clock.
 */
export interface TickPlan {
  /** Global, zero-based tick ordinal across the whole arc. */
  readonly index: number;
  /** Zero-based round this tick belongs to (`floor(index / ticks_per_round)`). */
  readonly roundIndex: number;
  /** Zero-based position within the round (`index % ticks_per_round`). */
  readonly tickInRound: number;
  /** True on the last tick of a round — the settle boundary (score + route). */
  readonly isRoundSettle: boolean;
  /** Offset from arc start in ms (`index * tick_rate_ms`). */
  readonly startOffsetMs: number;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`scheduler: ${label} must be a positive integer, got ${value}`);
  }
}

/**
 * Build the ordered tick plan for an arc of `totalTicks` ticks. `totalTicks`
 * must be a positive multiple of `ticks_per_round` so every round closes with a
 * settle tick — a trailing partial round would accumulate outcomes that never
 * score, silently dropping the agent's last decisions, so it is rejected rather
 * than left to settle-never.
 */
export function planTicks(totalTicks: number, timing: SchedulerTiming): TickPlan[] {
  assertPositiveInt(totalTicks, 'totalTicks');
  assertPositiveInt(timing.ticks_per_round, 'ticks_per_round');
  assertPositiveInt(timing.tick_rate_ms, 'tick_rate_ms');
  if (totalTicks % timing.ticks_per_round !== 0) {
    throw new RangeError(
      `scheduler: totalTicks (${totalTicks}) must be a whole multiple of ticks_per_round ` +
        `(${timing.ticks_per_round}) so every round settles`,
    );
  }

  const plan: TickPlan[] = [];
  for (let index = 0; index < totalTicks; index += 1) {
    const tickInRound = index % timing.ticks_per_round;
    plan.push({
      index,
      roundIndex: Math.floor(index / timing.ticks_per_round),
      tickInRound,
      isRoundSettle: tickInRound === timing.ticks_per_round - 1,
      startOffsetMs: index * timing.tick_rate_ms,
    });
  }
  return plan;
}

/** Number of rounds in an arc of `totalTicks` ticks (each `ticks_per_round` long). */
export function roundCount(totalTicks: number, timing: SchedulerTiming): number {
  assertPositiveInt(totalTicks, 'totalTicks');
  assertPositiveInt(timing.ticks_per_round, 'ticks_per_round');
  return Math.ceil(totalTicks / timing.ticks_per_round);
}

/**
 * Total wall-clock span of the arc in ms: `totalTicks * tick_rate_ms`. Changing
 * `tick_rate_ms` scales the demo's duration linearly and changing
 * `ticks_per_round` (hence the tick count) changes it predictably — the §7
 * config-sensitivity property judges rely on.
 */
export function arcDurationMs(totalTicks: number, tickRateMs: number): number {
  assertPositiveInt(totalTicks, 'totalTicks');
  assertPositiveInt(tickRateMs, 'tick_rate_ms');
  return totalTicks * tickRateMs;
}

/**
 * The virtual clock for a tick: `baseTimeMs + index * tick_rate_ms`. This is the
 * *only* time the deterministic logic sees — Intents are stamped and validated
 * against it, never `Date.now()` — so a replay reproduces identical signed bytes
 * regardless of when it runs.
 */
export function tickInstantMs(baseTimeMs: number, index: number, tickRateMs: number): number {
  if (!Number.isFinite(baseTimeMs)) {
    throw new RangeError(`scheduler: baseTimeMs must be finite, got ${baseTimeMs}`);
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`scheduler: index must be a non-negative integer, got ${index}`);
  }
  assertPositiveInt(tickRateMs, 'tick_rate_ms');
  return baseTimeMs + index * tickRateMs;
}
