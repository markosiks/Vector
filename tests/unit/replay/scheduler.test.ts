import { describe, expect, test } from 'bun:test';

import {
  arcDurationMs,
  planTicks,
  roundCount,
  tickInstantMs,
  type SchedulerTiming,
} from '@/lib/replay/scheduler';

/**
 * Unit: the deterministic tick scheduler (§6.5, §7.3). The plan's structure,
 * settle boundaries, and virtual clock are pure functions of the timing config;
 * invalid timing is rejected at the boundary.
 */

const TIMING: SchedulerTiming = { tick_rate_ms: 2_000, ticks_per_round: 5 };

describe('planTicks', () => {
  test('lays out a full arc with correct round/settle structure', () => {
    const plan = planTicks(10, TIMING);
    expect(plan).toHaveLength(10);

    expect(plan[0]).toEqual({
      index: 0,
      roundIndex: 0,
      tickInRound: 0,
      isRoundSettle: false,
      startOffsetMs: 0,
    });
    // Settle ticks are the last of each round (index 4 and 9).
    expect(plan.filter((t) => t.isRoundSettle).map((t) => t.index)).toEqual([4, 9]);
    expect(plan[5]).toEqual({
      index: 5,
      roundIndex: 1,
      tickInRound: 0,
      isRoundSettle: false,
      startOffsetMs: 10_000,
    });
    expect(plan[9]).toEqual({
      index: 9,
      roundIndex: 1,
      tickInRound: 4,
      isRoundSettle: true,
      startOffsetMs: 18_000,
    });
  });

  test('rejects a tick count that is not a whole multiple of ticks_per_round', () => {
    // A trailing partial round would never settle — reject it.
    expect(() => planTicks(7, TIMING)).toThrow(/whole multiple/);
  });

  test('rejects non-positive or non-integer inputs', () => {
    expect(() => planTicks(0, TIMING)).toThrow(/positive integer/);
    expect(() => planTicks(2.5, { tick_rate_ms: 1, ticks_per_round: 1 })).toThrow(
      /positive integer/,
    );
    expect(() => planTicks(5, { tick_rate_ms: 0, ticks_per_round: 5 })).toThrow(/positive integer/);
  });
});

describe('roundCount / arcDurationMs', () => {
  test('derive round count and total span from the grid', () => {
    expect(roundCount(45, TIMING)).toBe(9);
    expect(arcDurationMs(45, TIMING.tick_rate_ms)).toBe(90_000);
  });
});

describe('tickInstantMs (virtual clock)', () => {
  test('maps a tick to base + index * rate', () => {
    expect(tickInstantMs(1_000, 0, 2_000)).toBe(1_000);
    expect(tickInstantMs(1_000, 3, 2_000)).toBe(7_000);
  });

  test('rejects a negative index or non-finite base', () => {
    expect(() => tickInstantMs(0, -1, 2_000)).toThrow(/non-negative integer/);
    expect(() => tickInstantMs(Number.NaN, 0, 2_000)).toThrow(/finite/);
  });
});
