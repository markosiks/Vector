import { describe, expect, test } from 'bun:test';

import type { ScoreDto } from '@/lib/api/dto';
import { buildEwmaSeries, sparklineGeometry } from '@/lib/credibility/ewma';

/**
 * The EWMA series preserves the API's round order, drops non-finite scores
 * rather than poisoning the path, and keeps the *label* as the exact decimal
 * string. The geometry pins the axis to `[0,100]`, centres a single point, and
 * yields empty paths for an empty history.
 */

const score = (score_r: string, round = score_r): ScoreDto => ({
  round_id: `00000000-0000-0000-0000-${round.padStart(12, '0').slice(-12)}`,
  raw_r: score_r,
  score_r,
  components: null,
  created_at: '2026-06-07T12:00:00.000Z',
});

describe('buildEwmaSeries', () => {
  test('keeps order, clamps to [0,100], and labels with the exact string', () => {
    const s = buildEwmaSeries([score('80.5', '1'), score('7.000', '2'), score('73.250', '3')]);
    expect(s.points.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(s.points.map((p) => p.scoreLabel)).toEqual(['80.5', '7.0', '73.2']);
    expect(s.min).toBe(7);
    expect(s.max).toBe(80.5);
  });

  test('drops rounds whose score is not finite and re-indexes gap-free', () => {
    const s = buildEwmaSeries([score('10', '1'), score('not-a-number', '2'), score('20', '3')]);
    expect(s.points).toHaveLength(2);
    expect(s.points.map((p) => p.index)).toEqual([0, 1]);
    expect(s.points.map((p) => p.score)).toEqual([10, 20]);
  });

  test('drops DTO values that Number() accepts but are not canonical decimals', () => {
    // Regression: a hex literal like "0x10" coerces to a finite Number (16), so
    // the old `Number.isFinite` gate let it through — but labelling it via
    // formatScore (→ normalizeDecimal) throws and used to crash the whole chart.
    // It must now be dropped, exactly like NaN, leaving valid points gap-free.
    const s = buildEwmaSeries([
      score('30', '1'),
      score('0x10', '2'), // Number("0x10") === 16, but not a decimal literal
      score('40', '3'),
    ]);
    expect(s.points.map((p) => p.score)).toEqual([30, 40]);
    expect(s.points.map((p) => p.index)).toEqual([0, 1]);
    expect(s.points.map((p) => p.scoreLabel)).toEqual(['30.0', '40.0']);
  });

  test('an empty history yields an empty series with the default range', () => {
    const s = buildEwmaSeries([]);
    expect(s.points).toHaveLength(0);
    expect(s.min).toBe(0);
    expect(s.max).toBe(100);
  });
});

describe('sparklineGeometry', () => {
  const opts = { width: 100, height: 100, padding: 0 };

  test('empty series produces empty paths and no last point', () => {
    const g = sparklineGeometry(buildEwmaSeries([]), opts);
    expect(g.path).toBe('');
    expect(g.areaPath).toBe('');
    expect(g.last).toBeNull();
  });

  test('a single point is centred horizontally', () => {
    const g = sparklineGeometry(buildEwmaSeries([score('50', '1')]), opts);
    expect(g.points).toHaveLength(1);
    expect(g.points[0]!.x).toBe(50); // width/2
    expect(g.points[0]!.y).toBe(50); // 50/100 of the inner height, inverted
  });

  test('maps the full [0,100] axis: 100 to the top, 0 to the bottom', () => {
    const g = sparklineGeometry(buildEwmaSeries([score('100', '1'), score('0', '2')]), opts);
    expect(g.points[0]).toEqual({ x: 0, y: 0 });
    expect(g.points[1]).toEqual({ x: 100, y: 100 });
    expect(g.path).toBe('M0 0 L100 100');
    expect(g.areaPath.startsWith('M0 0 L100 100')).toBe(true);
    expect(g.areaPath.endsWith('Z')).toBe(true);
  });

  test('a flat history renders a flat line, not an auto-zoomed one', () => {
    const g = sparklineGeometry(buildEwmaSeries([score('50', '1'), score('50', '2')]), opts);
    expect(g.points.every((p) => p.y === 50)).toBe(true);
  });
});
