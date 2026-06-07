import { describe, expect, test } from 'bun:test';

import { clamp01, easeInOutCubic, flowDurationMs } from '@/lib/arena/easing';

describe('clamp01', () => {
  test('clamps to [0, 1] and maps NaN to 0', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
  });
});

describe('easeInOutCubic', () => {
  test('fixes the endpoints and the midpoint', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });

  test('is monotonic non-decreasing on [0, 1]', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i += 1) {
      const y = easeInOutCubic(i / 20);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  test('clamps out-of-range input rather than overshooting', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe('flowDurationMs', () => {
  const timing = { maxStep: 0.25, pollMs: 1500 } as const;
  // ceiling = min(1200, round(1500 * 0.8)) = 1200; floor = 250.

  test('a full max_step move takes the ceiling; zero takes the floor', () => {
    expect(flowDurationMs(0.25, timing)).toBe(1200);
    expect(flowDurationMs(0, timing)).toBe(250);
  });

  test('scales monotonically between floor and ceiling', () => {
    const half = flowDurationMs(0.125, timing);
    expect(half).toBeGreaterThan(250);
    expect(half).toBeLessThan(1200);
  });

  test('uses magnitude (sign-independent) and clamps beyond max_step', () => {
    expect(flowDurationMs(-0.25, timing)).toBe(1200);
    expect(flowDurationMs(5, timing)).toBe(1200);
  });

  test('a short poll lowers the ceiling', () => {
    expect(flowDurationMs(1, { maxStep: 0.25, pollMs: 600 })).toBe(Math.round(600 * 0.8));
  });

  test('degenerate inputs fall back to the floor, never NaN', () => {
    expect(flowDurationMs(NaN, timing)).toBe(250);
    expect(flowDurationMs(0.1, { maxStep: 0, pollMs: 1500 })).toBe(250);
  });
});
