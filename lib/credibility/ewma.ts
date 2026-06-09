import type { ScoreDto } from '@/lib/api/dto';
import { formatScore } from '@/lib/arena/format';
import { normalizeDecimal } from '@/lib/intent/canonical';

/**
 * EWMA score-history series + sparkline geometry for the Agent-detail screen.
 *
 * The read API returns an agent's scores already ordered by **round index**
 * (P1.5), so a backfilled/replayed round renders in sequence; this module keeps
 * that order and turns the decimal `score_r` strings into a plottable series and
 * an SVG path. The numeric `y` is a float used only for geometry (0–100 → pixel),
 * while the *label* is the exact `formatScore` string — the same "displayed ⊆
 * stored" rule the Arena uses, so the curve never implies a score the ledger
 * does not hold.
 *
 * It is pure and total: an empty history yields an empty series, a single round
 * yields a single point, and a corrupt/non-finite `score_r` is dropped rather
 * than poisoning the path with `NaN`.
 */

const SCORE_MIN = 0;
const SCORE_MAX = 100;

/** One plotted round on the EWMA curve. */
export interface EwmaPoint {
  /** Sequential position on the x-axis (0-based, gap-free after filtering). */
  readonly index: number;
  /** AgentScore clamped to `[0, 100]` for geometry only. */
  readonly score: number;
  /** Exact display label from {@link formatScore} (never a re-stringified float). */
  readonly scoreLabel: string;
  readonly roundId: string;
  readonly at: string;
}

/** The full series plus its observed value range (for axis hints). */
export interface EwmaSeries {
  readonly points: readonly EwmaPoint[];
  readonly min: number;
  readonly max: number;
}

function clampScore(x: number): number {
  return x < SCORE_MIN ? SCORE_MIN : x > SCORE_MAX ? SCORE_MAX : x;
}

/**
 * Build the EWMA series from an agent's score history (already round-ordered).
 * Rounds whose `score_r` is not a finite number are skipped; the remaining
 * points are re-indexed `0..n-1` so the curve has no gaps.
 */
export function buildEwmaSeries(scores: readonly ScoreDto[]): EwmaSeries {
  const points: EwmaPoint[] = [];
  for (const s of scores) {
    // Gate on the project's canonical decimal validator — the same notion of
    // validity `formatScore` relies on. `Number.isFinite(Number(x))` is laxer
    // (it accepts "1e3", "0x10", " 5 "), so a value that passed that gate could
    // still crash `formatScore` (→ `normalizeDecimal` throws) on a broken DTO.
    // Validating once here keeps the y-value and the label in agreement.
    let canonical: string;
    try {
      canonical = normalizeDecimal(s.score_r);
    } catch {
      continue;
    }
    const score = clampScore(Number(canonical));
    points.push({
      index: points.length,
      score,
      scoreLabel: formatScore(canonical),
      roundId: s.round_id,
      at: s.created_at,
    });
  }
  // Reduce, never spread. `Math.min(...values)` / `Math.max(...values)` throw
  // `RangeError: Maximum call stack size exceeded` once the array exceeds the
  // engine's argument-count limit (~65k in V8), which a long score history can
  // reach — crashing the chart render. A single linear pass keeps this total.
  let min = SCORE_MAX;
  let max = SCORE_MIN;
  for (const p of points) {
    if (p.score < min) min = p.score;
    if (p.score > max) max = p.score;
  }
  return {
    points,
    min: points.length > 0 ? min : SCORE_MIN,
    max: points.length > 0 ? max : SCORE_MAX,
  };
}

/** A point in SVG user space. */
export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

/** SVG geometry derived from an {@link EwmaSeries} for a fixed viewBox. */
export interface SparklineGeometry {
  readonly width: number;
  readonly height: number;
  readonly points: readonly PixelPoint[];
  /** Polyline `d` for the curve, or `''` when there is nothing to draw. */
  readonly path: string;
  /** Closed `d` filling under the curve to the baseline, or `''` when empty. */
  readonly areaPath: string;
  /** The final point (latest round), for a marker; `null` when empty. */
  readonly last: PixelPoint | null;
}

/** Options for {@link sparklineGeometry}; all have demo-tuned defaults. */
export interface SparklineOptions {
  readonly width?: number;
  readonly height?: number;
  readonly padding?: number;
}

/**
 * Project an {@link EwmaSeries} onto a fixed-size SVG viewBox. The score axis is
 * pinned to the full `[0, 100]` range (not the observed min/max) so the height
 * of the curve is comparable across agents and a flat history reads as flat, not
 * auto-zoomed. A single point is centred; an empty series yields empty paths.
 */
export function sparklineGeometry(
  series: EwmaSeries,
  opts: SparklineOptions = {},
): SparklineGeometry {
  const width = opts.width ?? 600;
  const height = opts.height ?? 160;
  const padding = opts.padding ?? 12;
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const n = series.points.length;

  const toPixel = (p: EwmaPoint): PixelPoint => {
    const x = n <= 1 ? width / 2 : padding + (p.index / (n - 1)) * innerW;
    const y = padding + (1 - p.score / SCORE_MAX) * innerH;
    return { x: round2(x), y: round2(y) };
  };

  const points = series.points.map(toPixel);
  if (points.length === 0) {
    return { width, height, points, path: '', areaPath: '', last: null };
  }

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const baseline = height - padding;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const areaPath = `${path} L${last.x} ${baseline} L${first.x} ${baseline} Z`;

  return { width, height, points, path, areaPath, last };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
