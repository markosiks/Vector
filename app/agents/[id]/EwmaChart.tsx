import type { ReactNode } from 'react';

import type { ScoreDto } from '@/lib/api/dto';
import { buildEwmaSeries, sparklineGeometry } from '@/lib/credibility/ewma';
import { formatTimestamp } from '@/lib/credibility/format';
import styles from './agent-detail.module.css';

const WIDTH = 640;
const HEIGHT = 180;

export interface EwmaChartProps {
  readonly scores: readonly ScoreDto[];
}

/**
 * The EWMA score curve over an agent's rounds. A static SVG — no animation, so
 * it is correct under `prefers-reduced-motion` with no special-casing — built
 * from {@link sparklineGeometry}, whose y-axis is pinned to the full `[0,100]`
 * range so the curve height is comparable across agents and a flat history reads
 * as flat. Empty/short histories degrade to an explicit empty state / single
 * marker rather than a broken path.
 */
export function EwmaChart({ scores }: EwmaChartProps): ReactNode {
  const series = buildEwmaSeries(scores);
  const geo = sparklineGeometry(series, { width: WIDTH, height: HEIGHT, padding: 16 });

  if (geo.points.length === 0) {
    return (
      <div className={styles.chartEmpty} data-testid="ewma-empty">
        No scored rounds yet.
      </div>
    );
  }

  const latest = series.points[series.points.length - 1]!;

  return (
    <figure className={styles.chart} data-testid="ewma-chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className={styles.chartSvg}
        role="img"
        aria-label={`Score history over ${series.points.length} rounds; latest ${latest.scoreLabel}`}
        preserveAspectRatio="none"
      >
        {[0, 50, 100].map((g) => {
          const y = 16 + (1 - g / 100) * (HEIGHT - 32);
          return <line key={g} x1={0} x2={WIDTH} y1={y} y2={y} className={styles.gridLine} />;
        })}
        {geo.areaPath ? <path d={geo.areaPath} className={styles.chartArea} /> : null}
        <path d={geo.path} className={styles.chartCurve} fill="none" />
        {geo.last ? (
          <circle cx={geo.last.x} cy={geo.last.y} r={4} className={styles.chartMarker} />
        ) : null}
      </svg>
      <figcaption className={styles.chartCaption}>
        <span>
          Latest <strong className={styles.mono}>{latest.scoreLabel}</strong>
        </span>
        <span className={styles.muted}>
          {series.points.length} round{series.points.length === 1 ? '' : 's'} · last{' '}
          {formatTimestamp(latest.at)}
        </span>
      </figcaption>
    </figure>
  );
}
